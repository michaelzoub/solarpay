// SPL2 over ESP-NOW. See splink.h for the mechanism and why it is shaped this way.
#include "splink.h"

#include <string.h>

#include "esp_crc.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_now.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "mbedtls/ecdh.h"
#include "mbedtls/md.h"
#include "mbedtls/sha256.h"
#include "nvs_flash.h"

static const char *TAG = "splink";

// Badges must all sit on one channel; ESP-NOW does not scan.
#define SPLINK_CHANNEL   1
#define SPLINK_MAGIC     0x324C5053u  // "SPL2" little-endian
#define BEACON_PERIOD_MS 120

#define X25519_LEN 32
#define MAC_LEN    8   // truncated HMAC-SHA256 carried on authenticated frames

typedef enum {
    F_BEACON    = 1,  // I exist, this is my role/sid/armed state
    F_KNOCK     = 2,  // I was just knocked, this hard, this long ago
    F_PAIR_REQ  = 3,  // I pick you; here is my public key
    F_PAIR_CONF = 4,  // I accept; here is mine
    F_DATA      = 5,  // authenticated application payload
    F_ACK       = 6,
    F_CLOSE     = 7,
    F_BCAST     = 8,  // plaintext broadcast, outside the link
} frame_type_t;

#pragma pack(push, 1)
typedef struct {
    uint32_t magic;
    uint8_t  type;
    uint8_t  role;
    uint32_t sid;
    uint32_t psid;      // intended peer's sid, 0 for undirected frames
} hdr_t;

typedef struct {
    hdr_t   h;
    uint8_t armed;
} beacon_t;

typedef struct {
    hdr_t    h;
    uint16_t dt_ms;     // ms since my impact -- no shared clock needed
    uint16_t mg;
} knock_t;

typedef struct {
    hdr_t   h;
    uint8_t pub[X25519_LEN];
} pair_t;

typedef struct {
    hdr_t    h;
    uint8_t  seq;
    uint8_t  len;
    uint8_t  mac[MAC_LEN];
    uint8_t  body[SPLINK_MAX_MESSAGE];
} data_t;

typedef struct {
    hdr_t   h;
    uint8_t seq;
    uint8_t mac[MAC_LEN];
} ack_t;

typedef struct {
    hdr_t   h;
    uint8_t why;
} close_t;
#pragma pack(pop)

typedef struct {
    bool     used;
    uint8_t  mac[6];
    uint32_t sid;
    uint8_t  role;
    bool     armed;
    int8_t   rssi;
    int64_t  last_seen_ms;
    // Last knock this peer reported, translated into our own clock.
    int64_t  impact_at_ms;
    uint16_t impact_mg;
} peer_slot_t;

static splink_role_t  s_role;
static splink_cbs_t   s_cbs;
static splink_state_t s_state = SPLINK_IDLE;
static uint8_t        s_self_mac[6];
static uint32_t       s_sid;
static int64_t        s_armed_until;
static int64_t        s_next_beacon;

static peer_slot_t    s_peers[SPLINK_MAX_PEERS];
static splink_peer_t  s_current;
static bool           s_have_current;

// Our own last knock.
static int64_t  s_impact_at_ms;
static uint16_t s_impact_mg;
static bool     s_impact_pending;   // waiting out the settle window
static int64_t  s_decide_at_ms;

// Handshake / session.
static uint8_t  s_priv[X25519_LEN], s_pub[X25519_LEN];
static uint8_t  s_session_key[32];
static bool     s_have_key;
static int64_t  s_handshake_deadline;
static uint32_t s_peer_sid;
static uint8_t  s_peer_mac[6];

// Outbound acked message.
static bool     s_sending;
static uint8_t  s_tx_seq;
static data_t   s_tx_frame;
static size_t   s_tx_len;
static int64_t  s_tx_next_retry, s_tx_deadline;
static uint8_t  s_last_rx_seq = 0xFF;

static void (*s_bcast_cb)(const char *, size_t, const uint8_t[6], int8_t, void *);
static void  *s_bcast_ctx;

static SemaphoreHandle_t s_lock;

static inline int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

// splink_peer() and friends can legitimately be called by the UI before
// splink_init() has run. Taking a NULL mutex asserts inside FreeRTOS, so these
// no-op until the lock exists.
#define LOCK()   do { if (s_lock) xSemaphoreTakeRecursive(s_lock, portMAX_DELAY); } while (0)
#define UNLOCK() do { if (s_lock) xSemaphoreGiveRecursive(s_lock); } while (0)

static const uint8_t BCAST_MAC[6] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};

// --- helpers ---------------------------------------------------------------

static void hdr_fill(hdr_t *h, frame_type_t t, uint32_t psid)
{
    h->magic = SPLINK_MAGIC;
    h->type  = (uint8_t)t;
    h->role  = (uint8_t)s_role;
    h->sid   = s_sid;
    h->psid  = psid;
}

static esp_err_t raw_send(const uint8_t mac[6], const void *buf, size_t len)
{
    return esp_now_send(mac, (const uint8_t *)buf, len);
}

static peer_slot_t *peer_find(const uint8_t mac[6])
{
    for (int i = 0; i < SPLINK_MAX_PEERS; i++) {
        if (s_peers[i].used && memcmp(s_peers[i].mac, mac, 6) == 0) {
            return &s_peers[i];
        }
    }
    return NULL;
}

static peer_slot_t *peer_get(const uint8_t mac[6])
{
    peer_slot_t *p = peer_find(mac);
    if (p) return p;
    for (int i = 0; i < SPLINK_MAX_PEERS; i++) {
        if (!s_peers[i].used) {
            memset(&s_peers[i], 0, sizeof(s_peers[i]));
            s_peers[i].used = true;
            memcpy(s_peers[i].mac, mac, 6);
            s_peers[i].rssi = -99;
            return &s_peers[i];
        }
    }
    // Table full: evict the stalest.
    peer_slot_t *old = &s_peers[0];
    for (int i = 1; i < SPLINK_MAX_PEERS; i++) {
        if (s_peers[i].last_seen_ms < old->last_seen_ms) old = &s_peers[i];
    }
    memset(old, 0, sizeof(*old));
    old->used = true;
    memcpy(old->mac, mac, 6);
    old->rssi = -99;
    return old;
}

// ESP-NOW needs an explicit peer entry before unicast.
static void ensure_espnow_peer(const uint8_t mac[6])
{
    if (esp_now_is_peer_exist(mac)) return;
    esp_now_peer_info_t pi = {0};
    memcpy(pi.peer_addr, mac, 6);
    pi.channel = SPLINK_CHANNEL;
    pi.ifidx   = WIFI_IF_STA;
    pi.encrypt = false;   // confidentiality comes from our own session key
    esp_now_add_peer(&pi);
}

// HMAC-SHA256 truncated to MAC_LEN, over the frame with the mac field zeroed.
static void auth_tag(const void *buf, size_t len, size_t mac_off, uint8_t out[MAC_LEN])
{
    uint8_t tmp[sizeof(data_t)];
    if (len > sizeof(tmp)) len = sizeof(tmp);
    memcpy(tmp, buf, len);
    memset(tmp + mac_off, 0, MAC_LEN);

    uint8_t full[32];
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    mbedtls_md_hmac(md, s_session_key, sizeof(s_session_key), tmp, len, full);
    memcpy(out, full, MAC_LEN);
}

static bool auth_check(const void *buf, size_t len, size_t mac_off, const uint8_t got[MAC_LEN])
{
    if (!s_have_key) return false;
    uint8_t want[MAC_LEN];
    auth_tag(buf, len, mac_off, want);
    // Constant-time compare.
    uint8_t diff = 0;
    for (int i = 0; i < MAC_LEN; i++) diff |= (uint8_t)(want[i] ^ got[i]);
    return diff == 0;
}

// mbedtls_ecp_mul() randomizes the Montgomery ladder for blinding and REJECTS a
// NULL RNG with BAD_INPUT_DATA. Passing NULL is what silently broke pairing.
static int rng_cb(void *ctx, unsigned char *buf, size_t len)
{
    (void)ctx;
    esp_fill_random(buf, len);
    return 0;
}

static bool keypair_new(void)
{
    esp_fill_random(s_priv, X25519_LEN);
    // RFC 7748 clamping.
    s_priv[0]  &= 248;
    s_priv[31] &= 127;
    s_priv[31] |= 64;

    static const uint8_t basepoint[X25519_LEN] = {9};
    mbedtls_ecp_group grp;
    mbedtls_ecp_point Q, B;
    mbedtls_mpi d;
    int rc;
    bool ok = false;

    mbedtls_ecp_group_init(&grp);
    mbedtls_ecp_point_init(&Q); mbedtls_ecp_point_init(&B);
    mbedtls_mpi_init(&d);

    if ((rc = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_CURVE25519)) != 0) goto out;
    if ((rc = mbedtls_mpi_read_binary_le(&d, s_priv, X25519_LEN)) != 0) goto out;
    if ((rc = mbedtls_mpi_read_binary_le(&B.MBEDTLS_PRIVATE(X), basepoint, X25519_LEN)) != 0) goto out;
    if ((rc = mbedtls_mpi_lset(&B.MBEDTLS_PRIVATE(Z), 1)) != 0) goto out;
    if ((rc = mbedtls_ecp_mul(&grp, &Q, &d, &B, rng_cb, NULL)) != 0) goto out;
    if ((rc = mbedtls_mpi_write_binary_le(&Q.MBEDTLS_PRIVATE(X), s_pub, X25519_LEN)) != 0) goto out;
    ok = true;

out:
    if (!ok) ESP_LOGE(TAG, "keypair generation failed: -0x%04x", -rc);
    mbedtls_mpi_free(&d);
    mbedtls_ecp_point_free(&Q); mbedtls_ecp_point_free(&B);
    mbedtls_ecp_group_free(&grp);
    return ok;
}

// Derive the session key from the ECDH shared secret, bound to both session ids
// so a recorded handshake cannot be reused for a different session.
static bool derive_key(const uint8_t peer_pub[X25519_LEN], uint32_t a_sid, uint32_t b_sid)
{
    mbedtls_ecp_group grp;
    mbedtls_ecp_point P, R;
    mbedtls_mpi d;
    uint8_t shared[X25519_LEN];
    bool ok = false;
    int rc = 0;

    mbedtls_ecp_group_init(&grp);
    mbedtls_ecp_point_init(&P); mbedtls_ecp_point_init(&R);
    mbedtls_mpi_init(&d);

    if ((rc = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_CURVE25519)) != 0) goto out;
    if ((rc = mbedtls_mpi_read_binary_le(&d, s_priv, X25519_LEN)) != 0) goto out;
    if ((rc = mbedtls_mpi_read_binary_le(&P.MBEDTLS_PRIVATE(X), peer_pub, X25519_LEN)) != 0) goto out;
    if ((rc = mbedtls_mpi_lset(&P.MBEDTLS_PRIVATE(Z), 1)) != 0) goto out;
    if ((rc = mbedtls_ecp_mul(&grp, &R, &d, &P, rng_cb, NULL)) != 0) goto out;
    if ((rc = mbedtls_mpi_write_binary_le(&R.MBEDTLS_PRIVATE(X), shared, X25519_LEN)) != 0) goto out;

    // Reject the all-zero shared secret (small-subgroup / invalid point).
    uint8_t acc = 0;
    for (int i = 0; i < X25519_LEN; i++) acc |= shared[i];
    if (acc == 0) goto out;

    // key = SHA256(shared || min(sid) || max(sid)) -- order-independent so both
    // sides derive the same value without agreeing who is "first".
    uint32_t lo = a_sid < b_sid ? a_sid : b_sid;
    uint32_t hi = a_sid < b_sid ? b_sid : a_sid;
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    mbedtls_sha256_starts(&sha, 0);
    mbedtls_sha256_update(&sha, shared, X25519_LEN);
    mbedtls_sha256_update(&sha, (uint8_t *)&lo, 4);
    mbedtls_sha256_update(&sha, (uint8_t *)&hi, 4);
    mbedtls_sha256_finish(&sha, s_session_key);
    mbedtls_sha256_free(&sha);
    ok = true;

out:
    if (!ok) ESP_LOGE(TAG, "ECDH shared-secret derivation failed: -0x%04x", -rc);
    mbedtls_mpi_free(&d);
    mbedtls_ecp_point_free(&P); mbedtls_ecp_point_free(&R);
    mbedtls_ecp_group_free(&grp);
    return ok;
}

static void close_link(splink_close_t why, bool tell_peer)
{
    if (tell_peer && s_state == SPLINK_PAIRED) {
        close_t c; hdr_fill(&c.h, F_CLOSE, s_peer_sid); c.why = (uint8_t)why;
        raw_send(s_peer_mac, &c, sizeof(c));
    }
    bool was = (s_state == SPLINK_PAIRED || s_state == SPLINK_HANDSHAKING);
    s_state = SPLINK_IDLE;
    s_have_key = false;
    s_sending = false;
    s_have_current = false;
    s_impact_pending = false;
    s_peer_sid = 0;
    memset(s_session_key, 0, sizeof(s_session_key));
    s_last_rx_seq = 0xFF;
    if (was && s_cbs.on_closed) s_cbs.on_closed(why, s_cbs.ctx);
}

// --- pairing decision ------------------------------------------------------

// Conditions 1-6 for a single peer. Condition 7 (uniqueness) is the caller's,
// because it is a property of the whole peer table, not of one peer.
static bool peer_qualifies(const peer_slot_t *p, int64_t t)
{
    if (!p->used) return false;
    if (t - p->last_seen_ms > 2000) return false;
    if (!p->armed) return false;                                  // (1)
    if (p->rssi < SPLINK_RSSI_GATE) return false;                 // (2)
    if (p->impact_mg == 0) return false;
    if (t - s_impact_at_ms > SPLINK_IMPACT_VALID_MS) return false;// (3)
    int64_t dt = p->impact_at_ms - s_impact_at_ms;
    if (dt < 0) dt = -dt;
    if (dt > SPLINK_IMPACT_MATCH_MS) return false;                // (4)
    uint16_t lo = p->impact_mg < s_impact_mg ? p->impact_mg : s_impact_mg;
    uint16_t hi = p->impact_mg < s_impact_mg ? s_impact_mg : p->impact_mg;
    if (hi == 0 || (uint32_t)lo * 100u / hi < SPLINK_IMPACT_RATIO_PCT) return false; // (5)
    if (p->role == (uint8_t)s_role) return false;                 // (6)
    return true;
}

// Score every peer against the seven conditions and pair only if exactly one
// qualifies. Deliberately refuses rather than picking the strongest.
static void decide_pairing(void)
{
    int64_t t = now_ms();
    if (t - s_impact_at_ms > SPLINK_IMPACT_VALID_MS) {
        s_impact_pending = false;
        return;
    }

    peer_slot_t *cand = NULL;
    int count = 0;

    for (int i = 0; i < SPLINK_MAX_PEERS; i++) {
        if (!peer_qualifies(&s_peers[i], t)) continue;
        cand = &s_peers[i];
        count++;
    }

    s_impact_pending = false;

    if (count == 0) return;
    if (count > 1) {                                              // (7)
        ESP_LOGW(TAG, "refusing: %d badges are equally valid candidates", count);
        if (s_cbs.on_ambiguous) s_cbs.on_ambiguous(count, s_cbs.ctx);
        return;
    }

    // Exactly one. The higher session id sends the request; the other answers,
    // so both sides cannot open a handshake at once.
    memcpy(s_peer_mac, cand->mac, 6);
    s_peer_sid = cand->sid;
    ensure_espnow_peer(s_peer_mac);
    if (!keypair_new()) return;
    s_state = SPLINK_HANDSHAKING;
    s_handshake_deadline = t + SPLINK_HANDSHAKE_MS;

    if (s_sid > s_peer_sid) {
        pair_t r; hdr_fill(&r.h, F_PAIR_REQ, s_peer_sid);
        memcpy(r.pub, s_pub, X25519_LEN);
        raw_send(s_peer_mac, &r, sizeof(r));
    }
    ESP_LOGI(TAG, "handshaking with %02x:%02x:%02x:%02x:%02x:%02x sid=%08lx rssi=%d",
             s_peer_mac[0], s_peer_mac[1], s_peer_mac[2],
             s_peer_mac[3], s_peer_mac[4], s_peer_mac[5],
             (unsigned long)s_peer_sid, cand->rssi);
}

static void enter_paired(peer_slot_t *p)
{
    s_state = SPLINK_PAIRED;
    s_current.sid = s_peer_sid;
    memcpy(s_current.mac, s_peer_mac, 6);
    s_current.rssi = p ? p->rssi : -99;
    s_have_current = true;
    s_last_rx_seq = 0xFF;
    ESP_LOGI(TAG, "PAIRED sid=%08lx", (unsigned long)s_peer_sid);
    if (s_cbs.on_paired) s_cbs.on_paired(&s_current, s_cbs.ctx);
}

// --- receive ---------------------------------------------------------------

static void on_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len)
{
    if (len < (int)sizeof(hdr_t)) return;
    const hdr_t *h = (const hdr_t *)data;
    if (h->magic != SPLINK_MAGIC) return;
    if (memcmp(info->src_addr, s_self_mac, 6) == 0) return;

    int8_t rssi = info->rx_ctrl ? (int8_t)info->rx_ctrl->rssi : -99;
    int64_t t = now_ms();

    LOCK();
    peer_slot_t *p = peer_get(info->src_addr);
    p->sid  = h->sid;
    p->role = h->role;
    p->last_seen_ms = t;
    // Exponential smoothing; a single reflected frame should not swing the gate.
    p->rssi = (p->rssi <= -99) ? rssi : (int8_t)((p->rssi * 3 + rssi) / 4);

    switch (h->type) {
    case F_BEACON:
        if (len >= (int)sizeof(beacon_t)) p->armed = ((const beacon_t *)data)->armed != 0;
        break;

    case F_KNOCK: {
        if (len < (int)sizeof(knock_t)) break;
        const knock_t *k = (const knock_t *)data;
        // dt is "ms since my impact", so it needs no shared clock.
        p->impact_at_ms = t - k->dt_ms;
        p->impact_mg    = k->mg;
        break;
    }

    case F_PAIR_REQ: {
        if (len < (int)sizeof(pair_t)) break;
        if (h->psid != s_sid) break;                 // not addressed to us
        if (s_state == SPLINK_HANDSHAKING) {
            // We chose them too; it must be the same badge.
            if (memcmp(info->src_addr, s_peer_mac, 6) != 0) break;
        } else if (s_state == SPLINK_ARMED) {
            // Our own settle window has not fired yet. Accept only if this peer
            // independently satisfies conditions 1-6 and is the sole candidate,
            // so a single badge cannot talk its way into a pairing.
            int n = 0;
            for (int i = 0; i < SPLINK_MAX_PEERS; i++) if (peer_qualifies(&s_peers[i], t)) n++;
            if (n != 1 || !peer_qualifies(p, t)) break;
            memcpy(s_peer_mac, info->src_addr, 6);
            s_peer_sid = h->sid;
            ensure_espnow_peer(s_peer_mac);
            if (!keypair_new()) break;
            s_impact_pending = false;
        } else {
            break;
        }
        const pair_t *r = (const pair_t *)data;
        if (!derive_key(r->pub, s_sid, h->sid)) { s_state = SPLINK_ARMED; s_have_key = false; break; }
        s_have_key = true;
        pair_t c; hdr_fill(&c.h, F_PAIR_CONF, h->sid);
        memcpy(c.pub, s_pub, X25519_LEN);
        raw_send(info->src_addr, &c, sizeof(c));
        enter_paired(p);
        break;
    }

    case F_PAIR_CONF: {
        if (len < (int)sizeof(pair_t)) break;
        if (h->psid != s_sid) break;
        if (s_state != SPLINK_HANDSHAKING) break;
        if (memcmp(info->src_addr, s_peer_mac, 6) != 0) break;
        const pair_t *c = (const pair_t *)data;
        if (!derive_key(c->pub, s_sid, h->sid)) { s_state = SPLINK_ARMED; s_have_key = false; break; }
        s_have_key = true;
        enter_paired(p);
        break;
    }

    case F_DATA: {
        if (s_state != SPLINK_PAIRED) break;
        if (memcmp(info->src_addr, s_peer_mac, 6) != 0) break;
        if (len < (int)(sizeof(data_t) - SPLINK_MAX_MESSAGE)) break;
        const data_t *d = (const data_t *)data;
        size_t body = d->len;
        if (body > SPLINK_MAX_MESSAGE) break;
        size_t want = sizeof(data_t) - SPLINK_MAX_MESSAGE + body;
        if ((size_t)len < want) break;
        if (!auth_check(data, want, offsetof(data_t, mac), d->mac)) {
            ESP_LOGW(TAG, "dropping data frame with a bad authentication tag");
            break;
        }
        // Always ack, even a duplicate: the peer may have missed our first ack.
        ack_t a; hdr_fill(&a.h, F_ACK, h->sid); a.seq = d->seq;
        memset(a.mac, 0, MAC_LEN);
        auth_tag(&a, sizeof(a), offsetof(ack_t, mac), a.mac);
        raw_send(info->src_addr, &a, sizeof(a));

        if (d->seq == s_last_rx_seq) break;   // duplicate, already delivered
        s_last_rx_seq = d->seq;
        if (s_cbs.on_message) {
            char buf[SPLINK_MAX_MESSAGE + 1];
            memcpy(buf, d->body, body);
            buf[body] = '\0';
            s_cbs.on_message(buf, body, s_cbs.ctx);
        }
        break;
    }

    case F_ACK: {
        if (!s_sending || s_state != SPLINK_PAIRED) break;
        if (memcmp(info->src_addr, s_peer_mac, 6) != 0) break;
        if (len < (int)sizeof(ack_t)) break;
        const ack_t *a = (const ack_t *)data;
        if (a->seq != s_tx_seq) break;
        if (!auth_check(data, sizeof(ack_t), offsetof(ack_t, mac), a->mac)) break;
        s_sending = false;
        if (s_cbs.on_delivered) s_cbs.on_delivered(s_cbs.ctx);
        break;
    }

    case F_CLOSE:
        if (s_state == SPLINK_PAIRED && memcmp(info->src_addr, s_peer_mac, 6) == 0) {
            close_link(SPLINK_CLOSE_PEER_LEFT, false);
        }
        break;

    case F_BCAST: {
        if (!s_bcast_cb) break;
        size_t off = sizeof(hdr_t);
        if ((size_t)len <= off) break;
        size_t body = (size_t)len - off;
        if (body > SPLINK_MAX_MESSAGE) body = SPLINK_MAX_MESSAGE;
        char buf[SPLINK_MAX_MESSAGE + 1];
        memcpy(buf, data + off, body);
        buf[body] = '\0';
        s_bcast_cb(buf, body, info->src_addr, rssi, s_bcast_ctx);
        break;
    }

    default: break;
    }
    UNLOCK();
}

// --- public ----------------------------------------------------------------

esp_err_t splink_init(splink_role_t role, const splink_cbs_t *cbs)
{
    s_role = role;
    if (cbs) s_cbs = *cbs;
    s_lock = xSemaphoreCreateRecursiveMutex();
    if (!s_lock) return ESP_ERR_NO_MEM;

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        // Do NOT erase: nvs holds the badge identity and RF calibration.
        ESP_LOGW(TAG, "nvs needs attention (%s); continuing without it",
                 esp_err_to_name(err));
    }

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    wifi_init_config_t wc = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wc));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    // Never associate; just own the channel.
    ESP_ERROR_CHECK(esp_wifi_set_channel(SPLINK_CHANNEL, WIFI_SECOND_CHAN_NONE));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    // Never left at the PHY default: see SPLINK_TX_POWER_QDBM. This is the
    // single biggest current draw the badge adds when it arms.
    ESP_ERROR_CHECK(esp_wifi_set_max_tx_power(SPLINK_TX_POWER_QDBM));
    int8_t tx_qdbm = 0;
    if (esp_wifi_get_max_tx_power(&tx_qdbm) == ESP_OK) {
        ESP_LOGI(TAG, "tx power %d.%02d dBm, rssi gate %d dBm",
                 tx_qdbm / 4, (tx_qdbm % 4) * 25, SPLINK_RSSI_GATE);
    }

    ESP_ERROR_CHECK(esp_now_init());
    ESP_ERROR_CHECK(esp_now_register_recv_cb(on_recv));

    esp_now_peer_info_t bp = {0};
    memcpy(bp.peer_addr, BCAST_MAC, 6);
    bp.channel = SPLINK_CHANNEL;
    bp.ifidx   = WIFI_IF_STA;
    bp.encrypt = false;
    ESP_ERROR_CHECK(esp_now_add_peer(&bp));

    ESP_ERROR_CHECK(esp_read_mac(s_self_mac, ESP_MAC_WIFI_STA));
    ESP_LOGI(TAG, "ESP-NOW up on channel %d, mac %02x:%02x:%02x:%02x:%02x:%02x, role %c",
             SPLINK_CHANNEL, s_self_mac[0], s_self_mac[1], s_self_mac[2],
             s_self_mac[3], s_self_mac[4], s_self_mac[5], (char)s_role);
    return ESP_OK;
}

uint32_t splink_arm(void)
{
    LOCK();
    do { s_sid = esp_random(); } while (s_sid == 0);
    s_state = SPLINK_ARMED;
    s_armed_until = now_ms() + SPLINK_ARM_TIMEOUT_MS;
    s_impact_pending = false;
    s_have_current = false;
    s_have_key = false;
    ESP_LOGI(TAG, "armed sid=%08lx role=%c", (unsigned long)s_sid, (char)s_role);
    UNLOCK();
    return s_sid;
}

void splink_disarm(splink_close_t why)
{
    LOCK();
    close_link(why, true);
    s_state = SPLINK_IDLE;
    UNLOCK();
}

bool splink_is_armed(void)
{
    return s_state == SPLINK_ARMED || s_state == SPLINK_HANDSHAKING || s_state == SPLINK_PAIRED;
}

splink_state_t splink_state(void) { return s_state; }

const splink_peer_t *splink_peer(void)
{
    if (!s_lock) return NULL;          // radio not up yet
    if (s_have_current) return &s_current;
    // Best current candidate, for the "how close am I" hint on screen.
    LOCK();
    peer_slot_t *best = NULL;
    int64_t t = now_ms();
    for (int i = 0; i < SPLINK_MAX_PEERS; i++) {
        peer_slot_t *p = &s_peers[i];
        if (!p->used || t - p->last_seen_ms > 2600) continue;
        if (p->role == (uint8_t)s_role) continue;
        if (!best || p->rssi > best->rssi) best = p;
    }
    if (best) {
        memcpy(s_current.mac, best->mac, 6);
        s_current.sid  = best->sid;
        s_current.rssi = best->rssi;
    }
    UNLOCK();
    return best ? &s_current : NULL;
}

void splink_feed_impact(uint16_t shock_mg)
{
    if (shock_mg < SPLINK_IMPACT_MG) return;
    int64_t t = now_ms();
    LOCK();
    // One knock per settle window; a single physical tap rings for a few samples.
    if (t - s_impact_at_ms < SPLINK_PAIR_SETTLE_MS) {
        if (shock_mg > s_impact_mg) s_impact_mg = shock_mg;
        UNLOCK();
        return;
    }
    s_impact_at_ms = t;
    s_impact_mg    = shock_mg;
    if (s_cbs.on_impact) s_cbs.on_impact(shock_mg, s_cbs.ctx);

    if (s_state == SPLINK_ARMED) {
        s_impact_pending = true;
        s_decide_at_ms   = t + SPLINK_PAIR_SETTLE_MS;
        knock_t k; hdr_fill(&k.h, F_KNOCK, 0);
        k.dt_ms = 0;
        k.mg    = shock_mg;
        raw_send(BCAST_MAC, &k, sizeof(k));
    }
    UNLOCK();
}

void splink_tick(void)
{
    int64_t t = now_ms();
    LOCK();

    if (s_state == SPLINK_ARMED || s_state == SPLINK_HANDSHAKING) {
        if (t >= s_next_beacon) {
            s_next_beacon = t + BEACON_PERIOD_MS;
            beacon_t b; hdr_fill(&b.h, F_BEACON, 0);
            b.armed = 1;
            raw_send(BCAST_MAC, &b, sizeof(b));
            // Re-announce a recent knock so a peer that missed the first frame
            // can still correlate it.
            if (s_impact_mg && t - s_impact_at_ms < SPLINK_IMPACT_VALID_MS) {
                knock_t k; hdr_fill(&k.h, F_KNOCK, 0);
                k.dt_ms = (uint16_t)(t - s_impact_at_ms);
                k.mg    = s_impact_mg;
                raw_send(BCAST_MAC, &k, sizeof(k));
            }
        }
    }

    if (s_impact_pending && t >= s_decide_at_ms) {
        decide_pairing();
    }

    if (s_state == SPLINK_HANDSHAKING) {
        if (s_sid > s_peer_sid && (t % 120) < 12) {
            pair_t r; hdr_fill(&r.h, F_PAIR_REQ, s_peer_sid);
            memcpy(r.pub, s_pub, X25519_LEN);
            raw_send(s_peer_mac, &r, sizeof(r));
        }
        if (t > s_handshake_deadline) {
            ESP_LOGW(TAG, "handshake timed out");
            s_state = SPLINK_ARMED;
            s_have_key = false;
        }
    }

    if (s_sending && s_state == SPLINK_PAIRED) {
        if (t >= s_tx_deadline) {
            s_sending = false;
            if (s_cbs.on_send_failed) s_cbs.on_send_failed(s_cbs.ctx);
        } else if (t >= s_tx_next_retry) {
            s_tx_next_retry = t + SPLINK_RETRY_MS;
            raw_send(s_peer_mac, &s_tx_frame, s_tx_len);
        }
    }

    if ((s_state == SPLINK_ARMED || s_state == SPLINK_HANDSHAKING) && t > s_armed_until) {
        ESP_LOGI(TAG, "arming window expired");
        close_link(SPLINK_CLOSE_EXPIRED, false);
    }

    UNLOCK();
}

esp_err_t splink_send_message(const char *text, size_t len)
{
    if (s_state != SPLINK_PAIRED || !s_have_key) return ESP_ERR_INVALID_STATE;
    if (s_sending) return ESP_ERR_INVALID_STATE;
    if (len > SPLINK_MAX_MESSAGE) return ESP_ERR_INVALID_SIZE;

    LOCK();
    hdr_fill(&s_tx_frame.h, F_DATA, s_peer_sid);
    s_tx_frame.seq = ++s_tx_seq;
    s_tx_frame.len = (uint8_t)len;
    memcpy(s_tx_frame.body, text, len);
    memset(s_tx_frame.mac, 0, MAC_LEN);
    s_tx_len = sizeof(data_t) - SPLINK_MAX_MESSAGE + len;
    auth_tag(&s_tx_frame, s_tx_len, offsetof(data_t, mac), s_tx_frame.mac);

    s_sending       = true;
    s_tx_next_retry = now_ms() + SPLINK_RETRY_MS;
    s_tx_deadline   = now_ms() + SPLINK_SEND_DEADLINE_MS;
    raw_send(s_peer_mac, &s_tx_frame, s_tx_len);
    UNLOCK();
    return ESP_OK;
}

bool splink_is_sending(void) { return s_sending; }

esp_err_t splink_broadcast(const char *text, size_t len)
{
    if (len > SPLINK_MAX_MESSAGE) return ESP_ERR_INVALID_SIZE;
    uint8_t buf[sizeof(hdr_t) + SPLINK_MAX_MESSAGE];
    hdr_fill((hdr_t *)buf, F_BCAST, 0);
    memcpy(buf + sizeof(hdr_t), text, len);
    return raw_send(BCAST_MAC, buf, sizeof(hdr_t) + len);
}

void splink_set_broadcast_handler(void (*cb)(const char *, size_t, const uint8_t[6], int8_t, void *),
                                  void *ctx)
{
    s_bcast_cb  = cb;
    s_bcast_ctx = ctx;
}

void splink_set_role(splink_role_t role)
{
    LOCK();
    if (s_role != role) {
        s_role = role;
        // Any link established under the old role is meaningless now.
        close_link(SPLINK_CLOSE_CANCELLED, true);
        memset(s_peers, 0, sizeof(s_peers));
        ESP_LOGI(TAG, "role is now %c", (char)role);
    }
    UNLOCK();
}

const uint8_t *splink_self_mac(void) { return s_self_mac; }

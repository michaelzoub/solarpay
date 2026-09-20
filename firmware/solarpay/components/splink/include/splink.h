// SPL2 -- the SolarPay badge-to-badge tap link, over ESP-NOW.
//
// What this layer is for: deciding, reliably, *which* badge you just tapped,
// and then moving a payment approval to that badge and nothing else.
//
// The mechanism is bilateral impact correlation. A deliberate knock between two
// badges is felt by both accelerometers within a few tens of milliseconds and by
// no other badge in the room, however close. Simultaneity discriminates far
// better than signal strength: measured on this hardware a knock is 1200-2700 mg
// against a 31-237 mg noise floor, whereas RSSI cannot separate "touching" from
// "an arm's length away" through the enclosure and lanyard.
//
// A peer becomes the counterparty only if ALL of these hold:
//   1. it is armed  -- and a badge arms only while a payment request is live
//   2. its smoothed RSSI is at or above the gate
//   3. we felt an impact within the last IMPACT_VALID_MS
//   4. it reported an impact within +/- IMPACT_MATCH_MS of ours
//   5. the two impacts were of comparable strength
//   6. its role is the opposite of ours
//   7. it is the ONLY peer satisfying 1-6 -- two candidates refuses both
//
// Condition 7 is why the decision waits PAIR_SETTLE_MS after our own knock
// rather than acting on the first qualifying frame: deciding immediately lets
// whichever badge transmits first win, before an equally valid second candidate
// has announced itself.
//
// Tapping never moves money. It establishes the link; the payer still presses A.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// --- tunables, all measured on real hardware unless noted -------------------

// A knock. Button presses produce 400-800 mg of shock, so a lower gate would
// treat every press as a tap; deliberate knocks run 1200-2700 mg.
#define SPLINK_IMPACT_MG        1200
// How long our own impact stays eligible to pair.
#define SPLINK_IMPACT_VALID_MS  1200
// How close in time the two impacts must be.
#define SPLINK_IMPACT_MATCH_MS  150
// Impacts must be of comparable strength: the weaker must be at least this
// percent of the stronger.
#define SPLINK_IMPACT_RATIO_PCT 25
// Wait this long after our own knock before deciding anything, so a second
// candidate has time to announce itself and be refused.
#define SPLINK_PAIR_SETTLE_MS   220
// Transmit power. The default is the PHY maximum, 20 dBm, which is absurd for
// a link measured in centimetres and is what browns the sender out on battery:
// a beacon every BEACON_PERIOD_MS at full power is a ~300 mA burst landing on
// top of the display DMA, and the badge resets. 11 dBm is ample for badges
// being knocked together and cuts the burst substantially. In 0.25 dBm units,
// as esp_wifi_set_max_tx_power() wants.
#define SPLINK_TX_POWER_QDBM    44        // 11 dBm
// How far SPLINK_TX_POWER_QDBM is below the 20 dBm default. Every RSSI figure
// below is measured relative to transmit power, so dropping the power shifts
// them all down by exactly this much and the thresholds must follow -- what
// discriminates is the *relative* reading, which is unchanged.
#define SPLINK_TX_POWER_DROP_DB 9

// Coarse range filter only. Deliberately loose: this repo's history shows
// badges held edge to edge reading below -62 dBm at 20 dBm transmit power, so
// a tight gate would stop pairing firing at all. Impact correlation is what
// actually discriminates. Shifted down with the transmit power, so it keeps
// the same margin it always had.
#define SPLINK_RSSI_GATE        (-70 - SPLINK_TX_POWER_DROP_DB)
// Arming expires by itself, so a badge is never quietly pairable.
#define SPLINK_ARM_TIMEOUT_MS   20000
// Pairing handshake must complete inside this.
#define SPLINK_HANDSHAKE_MS     900
// Acked data: retransmit interval and total deadline.
#define SPLINK_RETRY_MS         120
#define SPLINK_SEND_DEADLINE_MS 2500

#define SPLINK_MAX_PEERS        8
#define SPLINK_MAX_MESSAGE      160

typedef enum {
    SPLINK_ROLE_SENDER   = 'S',
    SPLINK_ROLE_MERCHANT = 'M',
} splink_role_t;

typedef enum {
    SPLINK_IDLE = 0,
    SPLINK_ARMED,
    SPLINK_HANDSHAKING,
    SPLINK_PAIRED,
    SPLINK_CLOSED,
} splink_state_t;

typedef enum {
    SPLINK_CLOSE_OK = 0,
    SPLINK_CLOSE_CANCELLED,
    SPLINK_CLOSE_EXPIRED,
    SPLINK_CLOSE_PEER_LEFT,
} splink_close_t;

typedef struct {
    uint8_t  mac[6];
    uint32_t sid;
    int8_t   rssi;        // smoothed
} splink_peer_t;

typedef struct {
    // Pairing succeeded with this peer.
    void (*on_paired)(const splink_peer_t *peer, void *ctx);
    // More than one peer was an equally valid candidate; both were refused.
    void (*on_ambiguous)(int count, void *ctx);
    // An authenticated application message arrived over the link.
    void (*on_message)(const char *text, size_t len, void *ctx);
    // Our outbound message was acknowledged by the peer.
    void (*on_delivered)(void *ctx);
    // Our outbound message could not be delivered before the deadline.
    void (*on_send_failed)(void *ctx);
    // The link ended.
    void (*on_closed)(splink_close_t why, void *ctx);
    // We felt a knock (for UI feedback).
    void (*on_impact)(uint16_t mg, void *ctx);
    void *ctx;
} splink_cbs_t;

// Brings up Wi-Fi in station mode and ESP-NOW. Never associates to an AP and
// never starts a network stack: the interface exists only to own the MAC layer.
esp_err_t splink_init(splink_role_t role, const splink_cbs_t *cbs);

// Open a pairing window. Returns our session id. Called only when a payment
// request is live; expires by itself after SPLINK_ARM_TIMEOUT_MS.
uint32_t splink_arm(void);
void     splink_disarm(splink_close_t why);
bool     splink_is_armed(void);

splink_state_t splink_state(void);
// The paired counterparty, or the current best candidate if not yet paired.
const splink_peer_t *splink_peer(void);

// Feed one accelerometer sample. Detects knocks and announces them.
void splink_feed_impact(uint16_t shock_mg);
// Drive timers, retries and the settle/decide step. Call every ~10 ms.
void splink_tick(void);

// Send an authenticated application message over the paired link. Delivery is
// acknowledged and retried; on_delivered or on_send_failed always fires.
esp_err_t splink_send_message(const char *text, size_t len);
bool      splink_is_sending(void);

// A plaintext broadcast, deliberately outside the link: the payer must be able
// to read the amount before deciding to tap. Never carries an approval.
esp_err_t splink_broadcast(const char *text, size_t len);
// Registers a handler for those broadcasts.
void      splink_set_broadcast_handler(void (*cb)(const char *text, size_t len,
                                                  const uint8_t mac[6], int8_t rssi,
                                                  void *ctx), void *ctx);

// Role is chosen on the home screen, after splink_init(), so one image serves
// both modes and the badge is never locked to one at build time.
void splink_set_role(splink_role_t role);

const uint8_t *splink_self_mac(void);

#ifdef __cplusplus
}
#endif

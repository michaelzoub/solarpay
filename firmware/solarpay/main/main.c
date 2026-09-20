// SolarPay -- a dedicated payment badge.
//
// Boots straight into SolarPay. Two first-class modes, chosen on the home
// screen: Sender and Merchant, ported from badges/solarpay_customer.lua and
// badges/solarpay_merchant.lua.
//
// The merchant is the badge on USB: the laptop pushes checkouts to it and reads
// approvals back. The sender is standalone on battery -- it learns the amount
// from the merchant's ESP-NOW broadcast and never needs a cable.
//
// Paying is two deliberate acts. Knocking the badges together establishes an
// authenticated link with exactly one counterparty; the payment is sent only
// after the payer presses A on a screen naming that merchant and the amount.
// A tap on its own never moves money.
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "bsp.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "spconsole.h"
#include "splink.h"
#include "ui.h"

static const char *TAG = "solarpay";

typedef enum { MODE_HOME = 0, MODE_SENDER, MODE_MERCHANT } mode_t;

static mode_t   s_mode = MODE_HOME;
static int      s_home_sel;                 // 0 sender, 1 merchant
static char     s_badge_id[13];             // from the Wi-Fi MAC

// --- the live checkout ------------------------------------------------------
static char     s_intent[33];
static char     s_nonce[33];
static char     s_item[25] = "PAYMENT";
static uint64_t s_lamports;
static int64_t  s_expires_ms;
static char     s_intent_packet[128];       // SP1:I:... rebroadcast verbatim
static char     s_item_packet[128];         // SP1:M:...

// --- transient result state -------------------------------------------------
static char     s_result[16];               // APPROVED / CONFIRMED / FAILED
static int64_t  s_result_until, s_result_started;
static int64_t  s_paid_until, s_paid_started;
static bool     s_confirming;
static char     s_note[64];
static char     s_payer_id[24];
static char     s_signature[96];
static char     s_approved_intent[33];

// The merchant used to close the radio link the instant an approval arrived,
// which left no channel open by the time the laptop had a signature -- so the
// sender never learned whether its money moved. The pair is now held open
// across settlement, for no longer than this.
#define SP_SETTLE_TIMEOUT_MS 10000
// The sender waits a beat longer than the merchant will hold the link, so a
// merchant-side timeout always reaches it as a verdict rather than as silence.
#define SP_SENDER_AWAIT_MS   12000
// How long a finished result stays on screen, either side.
#define SP_RESULT_MS         5000

static bool     s_awaiting_confirm;     // merchant: link held open for settlement
static int64_t  s_confirm_deadline;
static bool     s_relay_pending;        // merchant: a C:/X: relay is in flight

static char     s_buf_value[32], s_buf_detail[64], s_buf_card[160];

// paint() writes the shared s_buf_* strings and then hands them to LVGL, which
// keeps the pointers. It must therefore run on exactly one task. Radio
// callbacks (ESP-NOW receive), the serial console task and the button task all
// want to trigger a repaint, so they set this flag and the main loop does the
// drawing. Painting from all four raced on those buffers and produced torn text.
static volatile bool s_repaint = true;

static inline void request_paint(void) { s_repaint = true; }

// --- provisioned wallet, persisted so the sender keeps it on battery --------
static char     s_wallet[64];
static uint64_t s_balance_lamports;
static bool     s_have_wallet;

// The buyer's balance drops the instant the approval goes out, rather than at
// the end of a Solana round trip: a badge that still reads the old number after
// you have paid reads as a badge that did not take the payment.
//
// What is on screen during that window is balanceBefore - amountSpent, which is
// a display figure and not the truth. It does not carry the network fee and it
// is never written to NVS, so a badge that reboots mid-flight comes back to the
// last balance an actual settlement confirmed. It is replaced by the settled
// figure the moment the relay lands, and put back if settlement fails or never
// answers -- which is what s_balance_before is for.
static uint64_t s_balance_before;
static bool     s_balance_optimistic;

#define NVS_NS "solarpay"

// The mode is remembered so an unexpected restart -- a brownout on battery,
// say -- comes back to the mode the badge was in, instead of dropping the payer
// back to the home screen mid-checkout.
static void mode_store(int mode)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u8(h, "mode", (uint8_t)mode);
    nvs_commit(h);
    nvs_close(h);
}

static int mode_load(void)
{
    nvs_handle_t h;
    uint8_t v = MODE_HOME;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return MODE_HOME;
    nvs_get_u8(h, "mode", &v);
    nvs_close(h);
    return (v == MODE_SENDER || v == MODE_MERCHANT) ? v : MODE_HOME;
}

// ---------------------------------------------------------------------------
// Reset history -- diagnostics for battery-only sessions
// ---------------------------------------------------------------------------
#define RESET_HISTORY_LEN 10

static const char *reset_reason_name(esp_reset_reason_t r)
{
    return r == ESP_RST_POWERON  ? "power on"           :
           r == ESP_RST_BROWNOUT ? "BROWNOUT"           :
           r == ESP_RST_PANIC    ? "PANIC (crash)"      :
           r == ESP_RST_INT_WDT  ? "interrupt watchdog" :
           r == ESP_RST_TASK_WDT ? "task watchdog"      :
           r == ESP_RST_SW       ? "software restart"   :
           r == ESP_RST_EXT      ? "external reset"     :
           r == ESP_RST_DEEPSLEEP? "deep sleep"         : "other";
}

static void reset_history_record(esp_reset_reason_t reason)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    uint8_t ring[RESET_HISTORY_LEN] = {0};
    size_t len = sizeof(ring);
    if (nvs_get_blob(h, "rsthist", ring, &len) != ESP_OK) len = 0;
    uint8_t n = 0;
    nvs_get_u8(h, "rstcount", &n);
    // Oldest first; shift once full so the ring always ends with the latest.
    if (len < sizeof(ring)) {
        ring[len] = (uint8_t)reason;
        len++;
    } else {
        memmove(ring, ring + 1, sizeof(ring) - 1);
        ring[sizeof(ring) - 1] = (uint8_t)reason;
    }
    nvs_set_blob(h, "rsthist", ring, len);
    nvs_set_u8(h, "rstcount", (uint8_t)(n + 1));
    nvs_commit(h);
    nvs_close(h);
}

static void reset_history_dump(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    uint8_t ring[RESET_HISTORY_LEN] = {0};
    size_t len = sizeof(ring);
    uint8_t n = 0;
    if (nvs_get_blob(h, "rsthist", ring, &len) == ESP_OK) {
        nvs_get_u8(h, "rstcount", &n);
        char line[192];
        int off = snprintf(line, sizeof(line), "boots=%u history(oldest first):", (unsigned)n);
        for (size_t i = 0; i < len && off < (int)sizeof(line) - 24; i++) {
            off += snprintf(line + off, sizeof(line) - off, " %s;",
                            reset_reason_name((esp_reset_reason_t)ring[i]));
        }
        ESP_LOGW(TAG, "%s", line);
        spconsole_emit("reset_history", line);
    }
    nvs_close(h);
}

static void wallet_load(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) return;
    size_t len = sizeof(s_wallet);
    if (nvs_get_str(h, "wallet", s_wallet, &len) == ESP_OK && s_wallet[0]) s_have_wallet = true;
    nvs_get_u64(h, "balance", &s_balance_lamports);
    nvs_close(h);
}

static void wallet_store(const char *address, uint64_t lamports)
{
    snprintf(s_wallet, sizeof(s_wallet), "%s", address);
    s_balance_lamports = lamports;
    s_have_wallet = s_wallet[0] != '\0';

    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_str(h, "wallet", s_wallet);
    nvs_set_u64(h, "balance", lamports);
    nvs_commit(h);
    nvs_close(h);
}

// Put an optimistic deduction back. Safe to call whenever a payment stops
// being in flight: it does nothing unless a deduction is actually outstanding.
static void balance_rollback(const char *why)
{
    if (!s_balance_optimistic) return;
    s_balance_lamports   = s_balance_before;
    s_balance_optimistic = false;
    char f[96];
    snprintf(f, sizeof(f), "reason=%s|balance=%" PRIu64, why ? why : "unknown", s_balance_lamports);
    spconsole_emit("balance_restored", f);
}

// 6 leading and 6 trailing characters, as the Lua apps showed it.
static void wallet_short(char *out, size_t n)
{
    size_t len = strlen(s_wallet);
    if (len < 18) { snprintf(out, n, "WALLET NOT LINKED"); return; }
    snprintf(out, n, "%.6s...%s", s_wallet, s_wallet + len - 6);
}

static inline int64_t now_ms(void) { return esp_timer_get_time() / 1000; }
static bool have_intent(void) { return s_intent[0] != '\0'; }

// Last time a human or a counterparty did something. Drives the screensaver,
// which is the only thing that reads it.
static int64_t s_activity_ms;
#define IDLE_SCREENSAVER_MS 20000

static inline void note_activity(void) { s_activity_ms = now_ms(); }

// True when nothing is holding the rail up for us.
//
// There is no VBUS sense or fuel gauge on this board, so "on battery" has to be
// inferred. A laptop that has said anything in the last 45 s means a cable, and
// a sender on battery never has one -- it learns everything over the radio. The
// failure mode is the safe one: a badge on USB that the laptop has gone quiet
// on is treated as being on battery and merely animates more cheaply.
static bool on_battery(void) { return !spconsole_laptop_online(); }
static bool idling(void) { return now_ms() - s_activity_ms > IDLE_SCREENSAVER_MS; }

// Smoothed RSSI mapped to 0 (far) .. 255 (touching), for the orb. The gate for
// *pairing* is impact correlation, not this -- proximity here is a visual cue
// and nothing decides anything on it.
static uint8_t proximity(void)
{
    const splink_peer_t *p = splink_peer();
    if (!p) return 0;
    // The window shifts down with the transmit power along with the gate, so
    // "touching" still reads as 255 and the orb still blooms on contact.
    const int lo = -85 - SPLINK_TX_POWER_DROP_DB;
    const int hi = -45 - SPLINK_TX_POWER_DROP_DB;
    int r = p->rssi;
    if (r < lo) r = lo;
    if (r > hi) r = hi;
    return (uint8_t)(((r - lo) * 255) / (hi - lo));
}

// Both badges show the same signature, so both shorten it the same way.
static void short_sig(char *out, size_t n, const char *sig)
{
    size_t sl = strlen(sig);
    if (sl > 14) snprintf(out, n, "%.6s...%.6s", sig, sig + sl - 6);
    else         snprintf(out, n, "%.20s", sig);
}

static void money(char *out, size_t n, uint64_t lamports)
{
    // 1 SOL = 1e9 lamports, shown to 4 dp exactly as the Lua apps did.
    uint64_t whole = lamports / 1000000000ULL;
    uint64_t frac  = (lamports % 1000000000ULL) / 100000ULL;  // 4 dp
    snprintf(out, n, "%" PRIu64 ".%04" PRIu64 " SOL", whole, frac);
}

// ---------------------------------------------------------------------------
// LEDs -- behaviour carried over from the Lua apps
// ---------------------------------------------------------------------------
static void render_leds(void)
{
    // The ring speaks the same palette as the screen: mint for done, sky for
    // near, coral for stopped, butter for waiting. Saturated a little past the
    // on-screen pastels, because a diffused 2020 LED washes out otherwise.
    int64_t t = now_ms();
    bsp_led_clear();

    const splink_peer_t *p = splink_peer();
    bool paired   = splink_state() == SPLINK_PAIRED;
    bool touching = p && p->rssi >= SPLINK_RSSI_GATE;
    bool near     = p != NULL;

    if (s_mode == MODE_SENDER && t < s_paid_until) {
        if (strcmp(s_result, "FAILED") == 0) {
            bsp_led_set_all(255, 120, 100);
        } else {
            // s_paid_started is restamped when the settlement word lands, so the
            // ring flashes once on send and once more on the actual confirmation.
            int64_t e = t - s_paid_started;
            if (e < 1080) { int ph = (int)(e / 180); if (ph == 0 || ph == 2 || ph == 4) bsp_led_set_all(60, 230, 140); }
            // Confirmed holds the ring bright for the rest of the screen, the
            // same rule the merchant uses below: while the checkmark is up, the
            // badge in your hand should not already be dimming.
            else if (strcmp(s_result, "CONFIRMED") == 0) bsp_led_set_all(60, 230, 140);
            else bsp_led_set_all(20, 80, 48);
        }
    } else if (s_mode == MODE_MERCHANT && t < s_result_until) {
        if (strcmp(s_result, "FAILED") == 0) {
            bsp_led_set_all(255, 120, 100);
        } else {
            int64_t e = t - s_result_started;
            if (e < 1080) { int ph = (int)(e / 180); if (ph == 0 || ph == 2 || ph == 4) bsp_led_set_all(60, 230, 140); }
            else if (strcmp(s_result, "CONFIRMED") == 0) bsp_led_set_all(60, 230, 140);
            else bsp_led_set_all(20, 80, 48);
        }
    } else if (paired || (touching && near)) {
        bsp_led_set_all(60, 230, 140);
    } else if (near) {
        // Brightness tracks proximity, so the ring and the orb grow together.
        int level = 70 + (int)proximity() * 3 / 5;
        // This branch is entered the moment a merchant starts beaconing, which
        // on a sender is also the moment the orb jumps to NEAR. Both steps land
        // on the rail together, and on battery that is what browns the badge
        // out. Halve the ring here; the orb halves itself in frugal mode.
        if (on_battery()) level /= 2;
        if (s_mode == MODE_SENDER) { bsp_led_set(1, level/3, level*3/4, level); bsp_led_set(5, level/3, level*3/4, level); bsp_led_set(0, level/3, level*3/4, level); }
        else                       { bsp_led_set(2, level/3, level*3/4, level); bsp_led_set(3, level/3, level*3/4, level); bsp_led_set(4, level/3, level*3/4, level); }
    } else if (have_intent()) {
        int level = 90 + (int)((t % 1400) * 110 / 1400);
        if (s_mode == MODE_SENDER) bsp_led_set_all(level, level * 5 / 6, level / 3);
        else                       bsp_led_set_all(level / 4, level, level * 3 / 5);
    } else if (s_mode == MODE_SENDER) {
        bsp_led_set_all(6, 12, 16);
    } else if (s_mode == MODE_MERCHANT) {
        bsp_led_set_all(6, 14, 10);
    }
    bsp_led_show();
}

// ---------------------------------------------------------------------------
// Flow tracing
// ---------------------------------------------------------------------------
// A flicker is a screen that keeps changing without anyone asking it to, so the
// thing worth logging is the transition, not the frame. One line per change in
// the resolved screen, plus a paint-rate line once a second so a loop that
// repaints without changing anything is visible too.
#define TTAG "spflow"

static const char *s_prev_branch = "";
static uint8_t     s_prev_orb = 255;
static uint32_t    s_paints, s_changes;
static int64_t     s_rate_window;

static void render_traced(const char *branch, const ui_model_t *m)
{
    int64_t t = now_ms();
    s_paints++;

    bool changed = (branch != s_prev_branch) || ((uint8_t)m->orb != s_prev_orb);
    if (changed) {
        s_changes++;
        ESP_LOGI(TTAG, "%lld screen %s -> %s orb=%d prox=%u armed=%d state=%d peer=%d intent=%d",
                 (long long)t, s_prev_branch[0] ? s_prev_branch : "(boot)", branch,
                 (int)m->orb, (unsigned)m->orb_proximity,
                 (int)splink_is_armed(), (int)splink_state(),
                 splink_peer() ? 1 : 0, (int)have_intent());
        s_prev_branch = branch;
        s_prev_orb    = (uint8_t)m->orb;
    }

    if (t - s_rate_window >= 1000) {
        if (s_rate_window && (s_paints > 8 || s_changes > 2)) {
            ESP_LOGW(TTAG, "%lld rate paints=%lu changes=%lu in %lld ms",
                     (long long)t, (unsigned long)s_paints, (unsigned long)s_changes,
                     (long long)(t - s_rate_window));
        }
        s_paints = s_changes = 0;
        s_rate_window = t;
    }

    ui_render(m);
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
static void paint(void)
{
    ui_model_t m = {0};
    const char *branch = "?";
    int64_t t = now_ms();
    const splink_peer_t *p = splink_peer();
    bool paired   = splink_state() == SPLINK_PAIRED;
    bool near     = p != NULL;
    bool touching = p && p->rssi >= SPLINK_RSSI_GATE;

    if (s_mode == MODE_HOME) {
        branch = "home";
        m.screen = UI_SCREEN_HOME;
        m.home_selection = s_home_sel;
        render_traced(branch, &m);
        return;
    }

    m.screen = (s_mode == MODE_SENDER) ? UI_SCREEN_SENDER : UI_SCREEN_MERCHANT;
    m.card_bg = UI_PANEL;
    m.card_border = UI_PURPLE;
    m.card_border_w = 2;

    // ---------------- sender ----------------
    if (s_mode == MODE_SENDER) {
        if (t < s_paid_until) {
            bool settled = strcmp(s_result, "CONFIRMED") == 0;
            bool failed  = strcmp(s_result, "FAILED") == 0;

            // The hero is the balance from the moment of the buy, not the
            // amount: what the payer wants to see having paid is what they
            // have left. It is an estimate until the relay lands, and the
            // detail line under it says which.
            char amt[24]; money(amt, sizeof(amt), s_lamports);
            money(s_buf_value, sizeof(s_buf_value), s_balance_lamports);
            m.value = s_buf_value;
            m.mode = "payment";
            m.footer = "HOME  done";

            if (settled) {
                char sig_short[24] = "";
                if (s_signature[0]) short_sig(sig_short, sizeof(sig_short), s_signature);
                branch = "sender/confirmed";
                m.state = "Complete"; m.state_color = UI_MINT;
                m.orb = UI_ORB_CONFIRMED;
                snprintf(s_buf_detail, sizeof(s_buf_detail), "%s",
                         sig_short[0] ? sig_short : "settled on Solana");
            } else if (failed) {
                // The deduction has already been put back by the X: branch, so
                // the hero above is the pre-payment balance again. Say so,
                // rather than leaving the payer to compare two numbers.
                branch = "sender/unconfirmed";
                m.state = "Not confirmed"; m.state_color = UI_CORAL;
                m.orb = UI_ORB_FAILURE;
                snprintf(s_buf_detail, sizeof(s_buf_detail), "%s not taken · reconnect to refresh", amt);
            } else {
                branch = "sender/paid";
                m.state = "Sent"; m.state_color = UI_MINT;
                m.orb = UI_ORB_SUCCESS;
                snprintf(s_buf_detail, sizeof(s_buf_detail), "-%s · confirming on Solana", amt);
            }
            m.detail = s_buf_detail;
            render_traced(branch, &m); return;
        }
        if (have_intent()) {
            money(s_buf_value, sizeof(s_buf_value), s_lamports);
            m.value = s_buf_value;
            m.mode = "pay";

            if (s_confirming && paired) {
                // The decisive screen. The orb has merged, the amount is the
                // biggest thing on it, and one button does one thing.
                branch = "sender/confirm";
                m.state = "Ready"; m.state_color = UI_MINT;
                m.orb = UI_ORB_MERGED;
                snprintf(s_buf_detail, sizeof(s_buf_detail), "%s · merchant %02X%02X",
                         s_item, p ? p->mac[4] : 0, p ? p->mac[5] : 0);
                m.detail = s_buf_detail;
                // The payer is looking at two badges touching, not at the
                // screen, and looks back mid-bump. Whatever asks for this press
                // has to survive that glance, so it is a pill and not a hint.
                m.action = "A   Pay";
                m.footer = "B  cancel";
            } else if (near) {
                branch = "sender/near";
                m.state = "Nearby"; m.state_color = UI_SKY;
                m.orb = UI_ORB_NEAR;
                m.orb_proximity = proximity();
                m.detail = s_note[0] ? s_note
                         : (touching ? "knock the badges together" : "move closer to the merchant");
                m.footer = "B  decline";
            } else {
                branch = "sender/request";
                m.state = "Request"; m.state_color = UI_BUTTER;
                m.orb = UI_ORB_SEEKING;
                snprintf(s_buf_detail, sizeof(s_buf_detail), "%s · knock to pair", s_item);
                m.detail = s_note[0] ? s_note : s_buf_detail;
                m.footer = "B  decline";
            }
            render_traced(branch, &m); return;
        }
        m.mode = "send";
        if (splink_is_armed()) {
            // Initiated, waiting for the tap. Still knows nothing about any
            // charge -- that only arrives once a merchant is authenticated.
            // The 20 s arming window is why this screen is all orb: there is
            // nothing to read here, only something to do, quickly.
            branch = "sender/armed";
            m.state = near ? "Nearby" : "Looking";
            m.state_color = near ? UI_SKY : UI_BUTTER;
            m.orb = near ? UI_ORB_NEAR : UI_ORB_SEEKING;
            m.orb_proximity = proximity();
            m.value = "Knock";
            m.detail = s_note[0] ? s_note : "tap this badge on the merchant";
            m.footer = "B  cancel";
            render_traced(branch, &m); return;
        }
        if (idling() && s_have_wallet) {
            branch = "sender/idle-orb";
            m.state = "Ready"; m.state_color = UI_SKY;
            m.orb = UI_ORB_CALM;
            money(s_buf_value, sizeof(s_buf_value), s_balance_lamports);
            m.value = s_buf_value;
            // This is the screen the badge spends most of its life on, so the
            // way in has to be the same pill as everywhere else rather than a
            // line of small grey text under the balance.
            m.action = "A   Pay";
            render_traced(branch, &m); return;
        }
        branch = "sender/ready";
        m.state = "Ready"; m.state_color = UI_SKY;
        if (s_have_wallet) {
            money(s_buf_value, sizeof(s_buf_value), s_balance_lamports);
            m.kicker = "balance";
            m.value = s_buf_value;
            char w[32]; wallet_short(w, sizeof(w));
            snprintf(s_buf_detail, sizeof(s_buf_detail), "%s", w);
            m.detail = s_buf_detail;
            // Same press, same affordance, one step earlier in the flow: the
            // pill replaces the card that used to spell out what to do.
            m.action = "A   Pay";
            m.footer = "HOME  back";
        } else {
            m.state = "Setup"; m.state_color = UI_BUTTER;
            m.kicker = "balance";
            m.value = "—";
            m.detail = "no wallet linked yet";
            snprintf(s_buf_card, sizeof(s_buf_card), "Connect USB and run\nsetup on the laptop");
            m.footer = "HOME  back";
        }
        m.card_text = s_buf_card;
        render_traced(branch, &m); return;
    }

    // ---------------- merchant ----------------
    if (t < s_result_until) {
        bool failed  = strcmp(s_result, "FAILED") == 0;
        bool settled = strcmp(s_result, "CONFIRMED") == 0;
        char amt[24]; money(amt, sizeof(amt), s_lamports);
        char sig_short[24] = "";
        if (settled && s_signature[0]) short_sig(sig_short, sizeof(sig_short), s_signature);
        branch = "merchant/result";
        // Settled says it with the glyph alone: the terminal has one thing to
        // report and the orb below is already spelling it out.
        m.state = failed ? "Stopped" : (settled ? UI_GLYPH_OK : "Signing");
        m.state_color = failed ? UI_CORAL : (settled ? UI_MINT : UI_BUTTER);
        m.mode = "checkout";
        m.orb = failed ? UI_ORB_FAILURE : settled ? UI_ORB_CONFIRMED : UI_ORB_SUCCESS;
        snprintf(s_buf_value, sizeof(s_buf_value), "%s", amt);
        m.value = s_buf_value;
        snprintf(s_buf_detail, sizeof(s_buf_detail), "%s",
                 failed   ? "not settled · check the laptop log"
                 : settled ? (sig_short[0] ? sig_short : "settled on Solana")
                           : "approved · verifying on Solana");
        m.detail = s_buf_detail;
        m.footer = "HOME  done";
        render_traced(branch, &m); return;
    }
    if (have_intent()) {
        money(s_buf_value, sizeof(s_buf_value), s_lamports);
        m.value = s_buf_value;
        m.mode = "charge";
        branch = "merchant/paired";
        if (paired) {
            m.state = "Paired"; m.state_color = UI_MINT;
            m.orb = UI_ORB_MERGED;
            m.detail = s_note[0] ? s_note : "waiting for the payer to confirm";
        branch = "merchant/near";
        } else if (near) {
            m.state = "Nearby"; m.state_color = UI_SKY;
            m.orb = UI_ORB_NEAR;
            m.orb_proximity = proximity();
            m.detail = s_note[0] ? s_note
                     : (touching ? "knock the badges together" : "bring the payer closer");
        } else {
            branch = "merchant/live";
            m.state = "Live"; m.state_color = UI_BUTTER;
            m.orb = UI_ORB_SEEKING;
            snprintf(s_buf_detail, sizeof(s_buf_detail), "%s · waiting for a payer", s_item);
            m.detail = s_note[0] ? s_note : s_buf_detail;
        }
        m.footer = "B  cancel";
        render_traced(branch, &m); return;
    }
    {
        bool online = spconsole_laptop_online();
        m.mode = "merchant";
        m.state = online ? "Online" : "Offline";
        m.state_color = online ? UI_SKY : UI_HAIRLINE;

        branch = "merchant/idle-orb";
        if (idling() && online) {
            m.orb = UI_ORB_CALM;
            m.value = "Ready";
            m.detail = "create a payment on the laptop";
            render_traced(branch, &m); return;
        }
        branch = "merchant/till";
        m.kicker = "till";
        m.value = online ? "Ready" : "Offline";
        m.detail = online ? "create a payment on the laptop" : "connect USB to the laptop";
        {
            char w[32]; wallet_short(w, sizeof(w));
            snprintf(s_buf_card, sizeof(s_buf_card), "%s\n%s", s_badge_id, w);
        }
        m.card_text = s_buf_card;
        m.footer = "HOME  back";
        render_traced(branch, &m);
    }
}

// ---------------------------------------------------------------------------
// Checkout lifecycle
// ---------------------------------------------------------------------------
static void clear_intent(const char *why)
{
    char f[64];
    if (why) { snprintf(f, sizeof(f), "intent=%s", s_intent[0] ? s_intent : "none"); spconsole_emit(why, f); }
    s_intent[0] = s_nonce[0] = '\0';
    s_intent_packet[0] = s_item_packet[0] = '\0';
    s_approved_intent[0] = '\0';
    strcpy(s_item, "PAYMENT");
    s_lamports = 0;
    s_confirming = false;
    s_awaiting_confirm = false;
    s_relay_pending = false;
    s_note[0] = '\0';
    if (splink_is_armed()) splink_disarm(SPLINK_CLOSE_CANCELLED);
    request_paint();
}

// Back to the mode picker, tearing the checkout down on the way.
//
// Two callers now: the HOME button, and a sender whose payment has confirmed.
// A finished payment is the end of that badge's job, so it returns the payer to
// the same screen they would have reached by pressing HOME rather than leaving
// them on a stale payment screen. The mode is stored, so an unexpected restart
// after a payment comes back to the picker and not to a half-remembered
// checkout.
static void go_home(void)
{
    clear_intent(NULL);
    s_mode = MODE_HOME;
    mode_store(MODE_HOME);
    s_result_until = s_paid_until = 0;
    s_result[0] = '\0';
    bsp_led_clear(); bsp_led_show();
    request_paint();
}

// SP1:I:<intent>:<lamports>:<ttl>:<nonce>:<tag>
static bool parse_intent(const char *pkt)
{
    char intent[33], nonce[33], tag[17];
    unsigned long long lamports; unsigned ttl;
    int n = sscanf(pkt, "SP1:I:%32[0-9a-f]:%llu:%u:%32[A-Za-z0-9_-]:%16[A-Za-z0-9_-]",
                   intent, &lamports, &ttl, nonce, tag);
    if (n < 4) return false;
    if (ttl > 90) ttl = 90;
    snprintf(s_intent, sizeof(s_intent), "%s", intent);
    snprintf(s_nonce, sizeof(s_nonce), "%s", nonce);
    s_lamports   = (uint64_t)lamports;
    s_expires_ms = now_ms() + (int64_t)ttl * 1000;
    return true;
}

// SP1:M:<intent>:<item_name>
static void parse_item(const char *pkt)
{
    char intent[33], item[25];
    if (sscanf(pkt, "SP1:M:%32[0-9a-f]:%24[A-Za-z0-9_-]", intent, item) != 2) return;
    if (strcmp(intent, s_intent) != 0) return;
    for (char *c = item; *c; c++) if (*c == '_') *c = ' ';
    snprintf(s_item, sizeof(s_item), "%s", item);
}

// ---------------------------------------------------------------------------
// splink callbacks
// ---------------------------------------------------------------------------
static void cb_impact(uint16_t mg, void *ctx)
{
    char f[32]; snprintf(f, sizeof(f), "mag=%u", mg);
    if (s_mode == MODE_MERCHANT) spconsole_emit("impact", f);
}

static void cb_paired(const splink_peer_t *p, void *ctx)
{
    note_activity();
    char f[96];
    snprintf(f, sizeof(f), "peer_sid=%08" PRIx32 "|rssi=%d", p->sid, p->rssi);
    if (s_mode == MODE_SENDER) {
        // We have a counterparty but do not yet know what they want. The
        // request arrives over the link in a moment.
        s_confirming = false;
        snprintf(s_note, sizeof(s_note), "READING THE CHARGE...");
    } else {
        spconsole_emit("peer_detected", f);
        snprintf(s_note, sizeof(s_note), "SENDING THE CHARGE...");
        // Step 5 of the flow: details are exchanged only now that both badges
        // have discovered and authenticated each other.
        if (have_intent()) {
            char req[SPLINK_MAX_MESSAGE];
            int n = snprintf(req, sizeof(req), "REQ:%s:%" PRIu64 ":%s:%s",
                             s_intent, s_lamports, s_item, s_nonce);
            if (splink_send_message(req, (size_t)n) == ESP_OK) {
                spconsole_emit("charge_sent", f);
            }
        }
    }
    request_paint();
}

static void cb_ambiguous(int count, void *ctx)
{
    snprintf(s_note, sizeof(s_note), "TOO MANY BADGES - TRY AGAIN");
    if (s_mode == MODE_MERCHANT) {
        char f[48]; snprintf(f, sizeof(f), "reason=ambiguous_tap|count=%d", count);
        spconsole_emit("approval_ignored", f);
    }
    request_paint();
}

static void cb_message(const char *text, size_t len, void *ctx)
{
    // Sender side: the charge, delivered only after authentication.
    if (s_mode == MODE_SENDER) {
        // C:<intent>:<signature>:<lamports> -- the settlement word, relayed by
        // the merchant once the laptop holds a signature. Nothing is deducted
        // until this arrives, so the badge never shows money as spent that a
        // failed settlement would have to put back.
        if (strncmp(text, "C:", 2) == 0) {
            char intent[33] = {0}, sig[89] = {0};
            unsigned long long lamports = 0;
            int n = sscanf(text, "C:%32[0-9a-f]:%88[A-Za-z0-9]:%llu", intent, sig, &lamports);
            if (n < 2 || strcmp(intent, s_intent) != 0) {
                spconsole_emit("settlement_ignored", "reason=intent_mismatch");
                return;
            }
            s_signature[0] = '\0';
            if (strcmp(sig, "none") != 0) snprintf(s_signature, sizeof(s_signature), "%s", sig);
            // The laptop reads the payer's balance after the transfer settles,
            // so this figure already carries the network fee. A relay that
            // omits it still confirms; the balance simply stays until the next
            // USB provision.
            // The relayed figure is the truth and replaces the estimate,
            // fee included. A relay that omits it leaves the estimate standing
            // rather than rolling it back -- the payment did settle, so the
            // deduction was right even if the exact figure is a few thousand
            // lamports optimistic. Either way it is no longer provisional.
            if (n == 3 && s_have_wallet) wallet_store(s_wallet, (uint64_t)lamports);
            s_balance_optimistic = false;
            strcpy(s_result, "CONFIRMED");
            s_paid_started = now_ms();
            s_paid_until   = s_paid_started + SP_RESULT_MS;
            char f[200];
            snprintf(f, sizeof(f), "intent=%s|signature=%s|balance=%" PRIu64,
                     intent, sig, s_balance_lamports);
            spconsole_emit("settlement_confirmed", f);
            if (s_signature[0]) {
                printf("SOLARPAY_EXPLORER:https://explorer.solana.com/tx/%s?cluster=devnet\n",
                       s_signature);
                fflush(stdout);
            }
            request_paint();
            return;
        }
        // X:<intent> -- settlement failed. The balance is left exactly as it was.
        if (strncmp(text, "X:", 2) == 0) {
            char intent[33] = {0};
            if (sscanf(text, "X:%32[0-9a-f]", intent) != 1 || strcmp(intent, s_intent) != 0) return;
            balance_rollback("settlement_failed");
            strcpy(s_result, "FAILED");
            s_paid_started = now_ms();
            s_paid_until   = s_paid_started + SP_RESULT_MS;
            char f[64]; snprintf(f, sizeof(f), "intent=%s", intent);
            spconsole_emit("settlement_failed", f);
            request_paint();
            return;
        }
        char intent[33], item[25], nonce[33];
        unsigned long long lamports = 0;
        if (sscanf(text, "REQ:%32[0-9a-f]:%llu:%24[^:]:%32[A-Za-z0-9_-]",
                   intent, &lamports, item, nonce) != 4) {
            return;
        }
        snprintf(s_intent, sizeof(s_intent), "%s", intent);
        snprintf(s_nonce, sizeof(s_nonce), "%s", nonce);
        snprintf(s_item, sizeof(s_item), "%s", item);
        s_lamports   = (uint64_t)lamports;
        s_expires_ms = now_ms() + 90000;
        s_confirming = true;
        s_note[0] = '\0';
        ESP_LOGI(TAG, "charge received: %" PRIu64 " lamports for %s", s_lamports, s_item);
        request_paint();
        return;
    }
    if (s_mode != MODE_MERCHANT) return;
    char intent[33], payer[24], nonce[33];
    if (sscanf(text, "A:%32[0-9a-f]:%23[A-Za-z0-9_-]:%32[A-Za-z0-9_-]", intent, payer, nonce) != 3) {
        spconsole_emit("approval_ignored", "reason=malformed");
        return;
    }
    if (strcmp(intent, s_intent) != 0 || strcmp(nonce, s_nonce) != 0) {
        spconsole_emit("approval_ignored", "reason=intent_mismatch");
        return;
    }
    if (strcmp(s_approved_intent, intent) == 0) return;   // duplicate
    snprintf(s_approved_intent, sizeof(s_approved_intent), "%s", intent);
    snprintf(s_payer_id, sizeof(s_payer_id), "%s", payer);

    const splink_peer_t *p = splink_peer();
    int rssi = p ? p->rssi : 0;

    // The two lines the laptop has always parsed. Unchanged.
    spconsole_approval(intent, payer, nonce);
    char f[160];
    snprintf(f, sizeof(f), "method=splink|intent=%s|peer_badge_id=%s|rssi=%d", intent, payer, rssi);
    spconsole_emit("touch", f);
    snprintf(f, sizeof(f), "intent=%s|customer_badge_id=%s|nonce=%s|rssi=%d", intent, payer, nonce, rssi);
    spconsole_emit("approval_received", f);

    strcpy(s_result, "APPROVED");
    s_result_started = now_ms();
    s_result_until   = s_result_started + 90000;
    s_intent_packet[0] = s_item_packet[0] = '\0';   // stop broadcasting

    // The link is NOT closed here. Clearing the packets already silences the
    // beacon, so no new payer can pair; holding the pair open is what lets the
    // signature reach the sender once the laptop has settled on Solana.
    s_awaiting_confirm = true;
    s_confirm_deadline = s_result_started + SP_SETTLE_TIMEOUT_MS;
    request_paint();
}

// The merchant's half of settlement: send the verdict to the sender, then let
// go of the link. Called with the pair still open.
static void relay_settlement(const char *msg, size_t len)
{
    if (!s_awaiting_confirm) return;
    if (splink_state() != SPLINK_PAIRED || splink_send_message(msg, len) != ESP_OK) {
        // No link left, or the send would not start. Nothing more can be done
        // from here; the sender falls back to its own timeout.
        spconsole_emit("settlement_relay_failed", "reason=link_closed");
        s_awaiting_confirm = false;
        if (splink_is_armed()) splink_disarm(SPLINK_CLOSE_OK);
        return;
    }
    s_relay_pending = true;
}

static void finish_relay(const char *why)
{
    if (!s_awaiting_confirm && !s_relay_pending) return;
    s_relay_pending = false;
    s_awaiting_confirm = false;
    if (why) spconsole_emit("settlement_relay", why);
    if (splink_is_armed() || splink_state() == SPLINK_PAIRED) splink_disarm(SPLINK_CLOSE_OK);
}

static void cb_delivered(void *ctx)
{
    if (s_mode == MODE_SENDER) { snprintf(s_note, sizeof(s_note), "APPROVAL DELIVERED"); request_paint(); }
    else if (s_relay_pending) finish_relay("delivered=1");
}

static void cb_send_failed(void *ctx)
{
    if (s_mode == MODE_SENDER) {
        // The approval never reached the merchant, so nothing was ever spent.
        balance_rollback("approval_undelivered");
        s_paid_until = 0;
        snprintf(s_note, sizeof(s_note), "MERCHANT DID NOT ANSWER - PRESS A AGAIN");
        request_paint();
    } else if (s_relay_pending) {
        finish_relay("delivered=0");
    }
}

static void cb_closed(splink_close_t why, void *ctx)
{
    s_confirming = false;
    snprintf(s_note, sizeof(s_note), "%s",
             why == SPLINK_CLOSE_EXPIRED ? "PAIRING WINDOW CLOSED" : "LINK CLOSED");
    request_paint();
}

// Nothing is broadcast in the clear any more, so there is no broadcast handler.
// A sender learns what it is being asked to pay only after it has tapped a
// merchant and both sides have authenticated each other.

// ---------------------------------------------------------------------------
// Laptop -> merchant
// ---------------------------------------------------------------------------
// The laptop only ever talks to the merchant, so a checkout arriving over USB
// is itself the instruction to be a merchant. Entering the mode automatically
// means the till badge needs no button press to come up on the stand.
static void enter_merchant_if_needed(void)
{
    if (s_mode == MODE_MERCHANT) return;
    s_mode = MODE_MERCHANT;
    s_home_sel = 1;
    mode_store(MODE_MERCHANT);
    splink_set_role(SPLINK_ROLE_MERCHANT);
    spconsole_set_role("merchant");
    spconsole_identity("merchant", s_badge_id);
    spconsole_emit("app_enter", s_badge_id);
    ESP_LOGI(TAG, "entering MERCHANT mode (checkout arrived over USB)");
}

static void on_intent_line(const char *pkt, void *ctx)
{
    note_activity();
    enter_merchant_if_needed();
    if (!parse_intent(pkt)) { spconsole_emit("intent_load_failed", "reason=invalid_format"); return; }
    snprintf(s_intent_packet, sizeof(s_intent_packet), "%s", pkt);
    s_approved_intent[0] = '\0';
    s_result_until = 0;
    uint32_t sid = splink_arm();
    char f[96];
    snprintf(f, sizeof(f), "intent=%s|sid=%08" PRIx32, s_intent, sid);
    spconsole_emit("link_armed", f);
    snprintf(f, sizeof(f), "intent=%s|lamports=%" PRIu64, s_intent, s_lamports);
    spconsole_emit("intent_loaded", f);
    snprintf(f, sizeof(f), "intent=%s", s_intent);
    spconsole_emit("broadcast_requested", f);
    snprintf(s_note, sizeof(s_note), "WAITING FOR PAYER");
    request_paint();
}

static void on_item_line(const char *pkt, void *ctx)
{
    enter_merchant_if_needed();
    snprintf(s_item_packet, sizeof(s_item_packet), "%s", pkt);
    parse_item(pkt);
    request_paint();
}

static void on_wallet_line(const char *address, uint64_t lamports, void *ctx)
{
    wallet_store(address, lamports);
    char f[96];
    snprintf(f, sizeof(f), "balance=%" PRIu64, lamports);
    spconsole_emit("wallet_provisioned", f);
    ESP_LOGI(TAG, "wallet provisioned, balance %" PRIu64 " lamports", lamports);
    request_paint();
}

static void on_id_request(void *ctx)
{
    spconsole_identity(s_mode == MODE_MERCHANT ? "merchant" : "customer", s_badge_id);
}

static void on_confirm_line(const char *intent, void *ctx)
{
    if (s_mode != MODE_MERCHANT) return;
    // SP_CONFIRM <intent> [signature] [payer_lamports] -- both trailing fields
    // are optional, so a caller that sends only the intent still works. The
    // payer's balance has to come from the laptop: this badge knows its own
    // balance and nothing at all about the sender's.
    s_signature[0] = '\0';
    char id[33] = {0}, sig[89] = {0};
    unsigned long long payer_lamports = 0;
    int n = sscanf(intent, "%32s %88s %llu", id, sig, &payer_lamports);
    if (n < 1) return;
    if (n >= 2) {
        snprintf(s_signature, sizeof(s_signature), "%s", sig);
        printf("SOLARPAY_EXPLORER:https://explorer.solana.com/tx/%s?cluster=devnet\n",
               s_signature);
        fflush(stdout);
    }
    intent = id;
    strcpy(s_result, "CONFIRMED");
    s_result_started = now_ms(); s_result_until = s_result_started + SP_RESULT_MS;
    char f[64]; snprintf(f, sizeof(f), "intent=%s", intent);
    spconsole_emit("settlement_confirmed", f);

    // Relay before clearing the checkout: the sender is still paired and has
    // been sitting on "confirming on Solana" since it approved. The lamports
    // field is omitted rather than sent as zero when the laptop did not supply
    // one, so a missing balance never reads as an emptied wallet.
    char msg[SPLINK_MAX_MESSAGE];
    const char *sig_field = s_signature[0] ? s_signature : "none";
    int mn = (n >= 3)
        ? snprintf(msg, sizeof(msg), "C:%s:%s:%llu", id, sig_field, payer_lamports)
        : snprintf(msg, sizeof(msg), "C:%s:%s", id, sig_field);
    if (mn > 0) relay_settlement(msg, (size_t)mn);

    s_intent[0] = '\0'; s_intent_packet[0] = '\0'; s_item_packet[0] = '\0';
    request_paint();
}

static void on_fail_line(const char *intent, void *ctx)
{
    if (s_mode != MODE_MERCHANT) return;
    strcpy(s_result, "FAILED");
    s_result_started = now_ms(); s_result_until = s_result_started + SP_RESULT_MS;
    char f[64]; snprintf(f, sizeof(f), "intent=%s", intent);
    spconsole_emit("settlement_failed", f);

    // A failure is relayed for the same reason a confirmation is: silence would
    // leave the sender to time out, which looks identical to a lost radio link.
    char id[33] = {0};
    if (sscanf(intent, "%32s", id) == 1) {
        char msg[SPLINK_MAX_MESSAGE];
        int mn = snprintf(msg, sizeof(msg), "X:%s", id);
        if (mn > 0) relay_settlement(msg, (size_t)mn);
    }

    s_intent[0] = '\0'; s_intent_packet[0] = '\0'; s_item_packet[0] = '\0';
    request_paint();
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
// Called only from A, and only while paired. There is deliberately no path from
// "badges touched" straight to "paid".
static void approve(void)
{
    if (!have_intent()) return;
    if (splink_state() != SPLINK_PAIRED) {
        snprintf(s_note, sizeof(s_note), "KNOCK THE BADGES TOGETHER FIRST");
        bsp_led_set_all(255, 35, 65); bsp_led_show();
        request_paint();
        return;
    }
    if (splink_is_sending()) return;

    char msg[SPLINK_MAX_MESSAGE];
    int n = snprintf(msg, sizeof(msg), "A:%s:%s:%s", s_intent, s_badge_id, s_nonce);
    if (splink_send_message(msg, (size_t)n) != ESP_OK) {
        snprintf(s_note, sizeof(s_note), "COULD NOT SEND - TRY AGAIN");
        request_paint();
        return;
    }
    // Clear any verdict left from the previous payment, then wait for this
    // one's. Three seconds was enough only because the badge never expected an
    // answer; settling on Solana takes a network round trip.
    s_result[0] = '\0';
    s_signature[0] = '\0';

    // Deduct now. See s_balance_optimistic for why this is a display figure
    // and what puts it back.
    if (s_have_wallet && !s_balance_optimistic) {
        s_balance_before     = s_balance_lamports;
        s_balance_lamports   = (s_balance_lamports > s_lamports)
                             ? s_balance_lamports - s_lamports : 0;
        s_balance_optimistic = true;
        char f[96];
        snprintf(f, sizeof(f), "spent=%" PRIu64 "|balance=%" PRIu64,
                 s_lamports, s_balance_lamports);
        spconsole_emit("balance_deducted", f);
    }

    s_paid_started = now_ms();
    s_paid_until   = s_paid_started + SP_SENDER_AWAIT_MS;
    snprintf(s_note, sizeof(s_note), "SENDING APPROVAL...");
    request_paint();
}

static const char *btn_name(bsp_btn_t b)
{
    return b == BSP_BTN_A ? "A" : b == BSP_BTN_B ? "B" : b == BSP_BTN_HOME ? "HOME" :
           b == BSP_BTN_LEFT ? "LEFT" : b == BSP_BTN_RIGHT ? "RIGHT" :
           b == BSP_BTN_UP ? "UP" : b == BSP_BTN_DOWN ? "DOWN" :
           b == BSP_BTN_START ? "START" : "?";
}

static void on_button(bsp_btn_t btn, bsp_btn_edge_t edge, void *ctx)
{
    ESP_LOGI(TTAG, "%lld button %s %s mode=%d armed=%d intent=%d",
             (long long)now_ms(), btn_name(btn),
             edge == BSP_BTN_PRESSED ? "down" : "up",
             (int)s_mode, (int)splink_is_armed(), (int)have_intent());
    if (edge != BSP_BTN_PRESSED) return;
    note_activity();

    if (s_mode == MODE_HOME) {
        if (btn == BSP_BTN_LEFT)  { s_home_sel = 0; request_paint(); }
        if (btn == BSP_BTN_RIGHT) { s_home_sel = 1; request_paint(); }
        if (btn == BSP_BTN_A || btn == BSP_BTN_START) {
            s_mode = s_home_sel == 0 ? MODE_SENDER : MODE_MERCHANT;
            ESP_LOGI(TTAG, "%lld mode HOME -> %d", (long long)now_ms(), (int)s_mode);
            mode_store(s_mode);
            splink_set_role(s_home_sel == 0 ? SPLINK_ROLE_SENDER : SPLINK_ROLE_MERCHANT);
            spconsole_set_role(s_mode == MODE_MERCHANT ? "merchant" : "customer");
            if (s_mode == MODE_MERCHANT) spconsole_emit("app_enter", s_badge_id);
            ESP_LOGI(TAG, "mode: %s", s_mode == MODE_SENDER ? "SENDER" : "MERCHANT");
            request_paint();
        }
        return;
    }

    if (btn == BSP_BTN_HOME) {
        go_home();
        return;
    }

    if (s_mode == MODE_SENDER) {
        if (btn == BSP_BTN_A && have_intent()) approve();
        else if (btn == BSP_BTN_A) {
            // Step 1 of the flow: the sender initiates. Until this press the
            // badge is not pairable at all, so it cannot be drawn into a
            // payment by a merchant it was merely standing near.
            if (!s_have_wallet) {
                snprintf(s_note, sizeof(s_note), "LINK A WALLET FIRST");
            } else {
                uint32_t sid = splink_arm();
                ESP_LOGI(TTAG, "%lld arm by A sid=%08" PRIx32, (long long)now_ms(), sid);
                snprintf(s_note, sizeof(s_note), "KNOCK ON THE MERCHANT BADGE");
            }
            request_paint();
        }
        else if (btn == BSP_BTN_B && have_intent()) clear_intent("intent_declined");
    } else {
        if (btn == BSP_BTN_B && have_intent()) clear_intent("intent_cancelled");
    }
}

// ---------------------------------------------------------------------------
// Test harness (CONFIG_SOLARPAY_TEST_HARNESS, off in a shipping build)
// ---------------------------------------------------------------------------
// Knocking two badges together and pressing A are the only two acts that can
// move money, and neither has an injection point, so the end-to-end flow cannot
// be exercised without a pair of hands. These three commands give an automated
// harness the same two acts over USB. They enter through the same functions the
// real drivers call -- splink_feed_impact() and on_button() -- so the pairing
// correlation, the state machine and the radio are all genuinely under test.
// The accelerometer and the 74HC165 are the only things bypassed.
#if CONFIG_SOLARPAY_TEST_HARNESS

static void on_test_impact(uint16_t mg, void *ctx)
{
    splink_feed_impact(mg);
    char f[32]; snprintf(f, sizeof(f), "mg=%u", mg);
    spconsole_emit("test_impact", f);
}

static void on_test_btn(const char *name, void *ctx)
{
    static const struct { const char *name; bsp_btn_t btn; } map[] = {
        { "A", BSP_BTN_A }, { "B", BSP_BTN_B }, { "HOME", BSP_BTN_HOME },
        { "DOWN", BSP_BTN_DOWN }, { "LEFT", BSP_BTN_LEFT }, { "RIGHT", BSP_BTN_RIGHT },
        { "UP", BSP_BTN_UP }, { "AUX1", BSP_BTN_AUX1 }, { "START", BSP_BTN_START },
    };
    for (size_t i = 0; i < sizeof(map) / sizeof(map[0]); i++) {
        if (strcmp(name, map[i].name) == 0) {
            char f[32]; snprintf(f, sizeof(f), "btn=%s", map[i].name);
            spconsole_emit("test_btn", f);
            on_button(map[i].btn, BSP_BTN_PRESSED, NULL);
            on_button(map[i].btn, BSP_BTN_RELEASED, NULL);
            return;
        }
    }
    spconsole_emit("test_btn_unknown", name);
}

// One line the harness can assert every expectation against, so a test never
// has to infer state by scraping the log of events that led to it.
static void on_test_state(void *ctx)
{
    const splink_peer_t *p = splink_peer();
    splink_state_t st = splink_state();
    const char *st_name = st == SPLINK_IDLE         ? "idle"
                        : st == SPLINK_ARMED        ? "armed"
                        : st == SPLINK_HANDSHAKING  ? "handshaking"
                        : st == SPLINK_PAIRED       ? "paired"
                                                    : "closed";
    int64_t t = now_ms();
    char f[800];
    snprintf(f, sizeof(f),
             "mode=%s|link=%s|armed=%d|sending=%d|peer=%d|rssi=%d"
             "|intent=%s|lamports=%" PRIu64 "|item=%s|nonce=%s"
             "|confirming=%d|awaiting=%d|signature=%s|approved=%s|result=%s|result_ms=%" PRId64
             "|paid_ms=%" PRId64 "|expires_ms=%" PRId64
             "|wallet=%d|balance=%" PRIu64 "|note=%s|heap=%lu",
             s_mode == MODE_HOME ? "home" : s_mode == MODE_SENDER ? "sender" : "merchant",
             st_name, splink_is_armed() ? 1 : 0, splink_is_sending() ? 1 : 0,
             p ? 1 : 0, p ? p->rssi : 0,
             s_intent[0] ? s_intent : "none", s_lamports,
             s_item[0] ? s_item : "none", s_nonce[0] ? s_nonce : "none",
             s_confirming ? 1 : 0,
             s_awaiting_confirm ? 1 : 0,
             s_signature[0] ? s_signature : "none",
             s_approved_intent[0] ? s_approved_intent : "none",
             s_result[0] ? s_result : "none",
             s_result_until > t ? s_result_until - t : 0,
             s_paid_until > t ? s_paid_until - t : 0,
             have_intent() && s_expires_ms > t ? s_expires_ms - t : 0,
             s_have_wallet ? 1 : 0, s_balance_lamports,
             s_note[0] ? s_note : "none",
             (unsigned long)esp_get_free_heap_size());
    spconsole_emit("test_state", f);
}

// esp_restart() reports ESP_RST_SW, which is one of the reset reasons that
// restores the mode from NVS. An esptool reset cannot test that path: it
// reports ESP_RST_EXT, which is deliberately treated as a considered restart
// and lands on home. So this is the only way to exercise the brownout-recovery
// behaviour from a laptop.
static void on_test_reboot(void *ctx)
{
    spconsole_emit("test_reboot", NULL);
    vTaskDelay(pdMS_TO_TICKS(50));   // let the line reach the laptop first
    esp_restart();
}

#endif  // CONFIG_SOLARPAY_TEST_HARNESS

// ---------------------------------------------------------------------------
void app_main(void)
{
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_badge_id, sizeof(s_badge_id), "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    esp_err_t nvs_err = nvs_flash_init();
    if (nvs_err != ESP_OK) {
        // Never erase: nvs holds the badge identity and RF calibration.
        ESP_LOGW(TAG, "nvs_flash_init: %s", esp_err_to_name(nvs_err));
    }
    wallet_load();

    esp_reset_reason_t reason = esp_reset_reason();
    const char *reason_name = reset_reason_name(reason);
    ESP_LOGW(TAG, "boot reason: %s (%d)", reason_name, (int)reason);
    // On battery there is no console listening, so the reason a reset happened
    // is lost exactly when it matters. Keep a short history in NVS instead and
    // replay it on the next boot, so a USB session can tell a BROWNOUT (a power
    // budget problem) from a PANIC (a bug) after the fact. They are
    // indistinguishable on screen: both land back on the home screen.
    reset_history_record(reason);
    reset_history_dump();

    ESP_ERROR_CHECK(bsp_display_init());
    ESP_ERROR_CHECK(bsp_input_init());
    ESP_ERROR_CHECK(bsp_led_init());
    ESP_ERROR_CHECK(bsp_accel_init());
    bsp_input_set_callback(on_button, NULL);

    ui_init();

    spconsole_cbs_t ccbs = {
        .on_intent  = on_intent_line,
        .on_item    = on_item_line,
        .on_confirm = on_confirm_line,
        .on_fail    = on_fail_line,
        .on_wallet  = on_wallet_line,
        .on_id_request = on_id_request,
#if CONFIG_SOLARPAY_TEST_HARNESS
        .on_test_impact = on_test_impact,
        .on_test_btn    = on_test_btn,
        .on_test_state  = on_test_state,
        .on_test_reboot = on_test_reboot,
#endif
    };
    spconsole_init(&ccbs, s_mode == MODE_MERCHANT ? "merchant" : "customer");
    // Announce identity unprompted so a website that connects mid-session and
    // never sends SP_ID still learns which badge this is.
    spconsole_identity("customer", s_badge_id);

    splink_cbs_t lcbs = {
        .on_paired      = cb_paired,
        .on_ambiguous   = cb_ambiguous,
        .on_message     = cb_message,
        .on_delivered   = cb_delivered,
        .on_send_failed = cb_send_failed,
        .on_closed      = cb_closed,
        .on_impact      = cb_impact,
    };
    // mode_store() has always persisted the mode so that "an unexpected restart
    // -- a brownout on battery, say -- comes back to the mode the badge was in,
    // instead of dropping the payer back to the home screen mid-checkout". The
    // matching load was never wired up, so s_mode was always MODE_HOME here and
    // the restore below was dead code: every brownout did drop the payer to the
    // home screen. Restore only after an *unexpected* reset, so deliberately
    // switching the badge on still lands on home, as someone would expect.
    if (reason == ESP_RST_BROWNOUT || reason == ESP_RST_PANIC ||
        reason == ESP_RST_INT_WDT  || reason == ESP_RST_TASK_WDT ||
        reason == ESP_RST_SW) {
        s_mode = (mode_t)mode_load();
        s_home_sel = (s_mode == MODE_MERCHANT) ? 1 : 0;
    }

    ESP_ERROR_CHECK(splink_init(SPLINK_ROLE_SENDER, &lcbs));
    if (s_mode != MODE_HOME) {
        splink_set_role(s_mode == MODE_MERCHANT ? SPLINK_ROLE_MERCHANT : SPLINK_ROLE_SENDER);
        ESP_LOGW(TAG, "restored %s mode from NVS after %s",
                 s_mode == MODE_MERCHANT ? "MERCHANT" : "SENDER", reason_name);
    }

    paint();

    if (s_have_wallet) {
        char w[32]; wallet_short(w, sizeof(w));
        ESP_LOGI(TAG, "wallet from NVS: %s, balance %" PRIu64 " lamports", w, s_balance_lamports);
    } else {
        ESP_LOGI(TAG, "no wallet provisioned yet (send SP_WALLET <address> <lamports>)");
    }
#if CONFIG_SOLARPAY_TEST_HARNESS
    ESP_LOGW(TAG, "TEST HARNESS BUILD -- SP_TEST_* can approve payments over USB. Not for shipping.");
    spconsole_emit("test_harness", "enabled=1");
#endif
    ESP_LOGI(TAG, "SolarPay ready, badge %s, heap %lu",
             s_badge_id, (unsigned long)esp_get_free_heap_size());

    int64_t next_led = 0, next_paint = 0;
    for (;;) {
        int64_t t = now_ms();

        bsp_accel_sample_t s;
        if (bsp_accel_read(&s) == ESP_OK) {
            uint16_t shock = bsp_accel_shock_mg();
            if (shock >= SPLINK_IMPACT_MG) splink_feed_impact(shock);
        }
        splink_tick();

        // Nothing about the checkout goes out in the clear. The merchant's
        // beacon says only "a merchant here is armed"; the amount, item, intent
        // and nonce travel over the authenticated link after pairing.

        // The arming window exists so a badge is never pairable WITHOUT a live
        // checkout -- not to cut one short. A checkout can outlive the 20 s
        // window (they are issued with up to 90 s TTL), so re-arm while it is
        // still live. Without this a tap made more than 20 s after the checkout
        // appeared silently did nothing, with both badges still showing it.
        if (have_intent() && t < s_expires_ms && !splink_is_armed()
            && s_approved_intent[0] == '\0' && !s_paid_until) {
            uint32_t sid = splink_arm();
            ESP_LOGI(TAG, "re-armed sid=%08" PRIx32 " (checkout still live)", sid);
        }

        // The pair is held open only for settlement. If the laptop never comes
        // back -- lost network, closed tab -- the link must not stay up.
        if (s_awaiting_confirm && !s_relay_pending && t >= s_confirm_deadline) {
            s_awaiting_confirm = false;
            spconsole_emit("settlement_relay_failed", "reason=timeout");
            if (splink_is_armed() || splink_state() == SPLINK_PAIRED) splink_disarm(SPLINK_CLOSE_OK);
        }

        if (have_intent() && t >= s_expires_ms) clear_intent("intent_expired");
        if (s_paid_until && t >= s_paid_until && !splink_is_sending()) {
            // Settlement went quiet rather than failing. The approval was
            // delivered -- an undelivered one would have come back through
            // cb_send_failed and been rolled back there -- so the merchant had
            // it and was settling, and the deduction is far more likely right
            // than wrong. It stands, unpersisted: the next USB provision, or a
            // reboot, replaces the estimate with whatever actually happened.
            if (s_balance_optimistic && s_result[0] == '\0') {
                s_balance_optimistic = false;
                spconsole_emit("balance_unconfirmed", "reason=settlement_silent");
            }
            // A confirmed payment is finished business: the payer is returned
            // to the mode picker. Every other way out of the result screen --
            // a settlement that failed, or one that never came back at all --
            // leaves the badge in sender mode, because the payer may well want
            // to look at it, or try again, and home is not where either of
            // those starts.
            if (s_mode == MODE_SENDER && strcmp(s_result, "CONFIRMED") == 0) {
                go_home();
            } else {
                s_paid_until = 0;
                clear_intent(NULL);
            }
        }

        // Cheap, and only a change does any work: see ui_set_frugal().
        ui_set_frugal(on_battery());

        if (t >= next_led)  { next_led = t + 75; render_leds(); }
        if (s_repaint || t >= next_paint) {
            s_repaint = false;
            next_paint = t + 200;
            paint();
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

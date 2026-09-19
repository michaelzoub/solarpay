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
static int64_t  s_next_bcast;

// --- transient result state -------------------------------------------------
static char     s_result[16];               // APPROVED / CONFIRMED / FAILED
static int64_t  s_result_until, s_result_started;
static int64_t  s_paid_until, s_paid_started;
static bool     s_confirming;
static char     s_note[64];
static char     s_payer_id[24];
static char     s_approved_intent[33];

static char     s_buf_kicker[48], s_buf_value[32], s_buf_detail[64], s_buf_card[128];

static inline int64_t now_ms(void) { return esp_timer_get_time() / 1000; }
static bool have_intent(void) { return s_intent[0] != '\0'; }

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
    int64_t t = now_ms();
    bsp_led_clear();

    const splink_peer_t *p = splink_peer();
    bool paired   = splink_state() == SPLINK_PAIRED;
    bool touching = p && p->rssi >= SPLINK_RSSI_GATE;
    bool near     = p != NULL;

    if (s_mode == MODE_SENDER && t < s_paid_until) {
        int64_t e = t - s_paid_started;
        if (e < 1080) { int ph = (int)(e / 180); if (ph == 0 || ph == 2 || ph == 4) bsp_led_set_all(0, 255, 90); }
        else bsp_led_set_all(0, 80, 35);
    } else if (s_mode == MODE_MERCHANT && t < s_result_until) {
        if (strcmp(s_result, "FAILED") == 0) {
            bsp_led_set_all(255, 25, 45);
        } else {
            int64_t e = t - s_result_started;
            if (e < 1080) { int ph = (int)(e / 180); if (ph == 0 || ph == 2 || ph == 4) bsp_led_set_all(0, 255, 90); }
            else if (strcmp(s_result, "CONFIRMED") == 0) bsp_led_set_all(0, 255, 90);
            else bsp_led_set_all(0, 80, 35);
        }
    } else if (paired || (touching && near)) {
        bsp_led_set_all(0, 255, 90);
    } else if (near) {
        int level = 110 + (int)((t % 900) * 145 / 900);
        if (s_mode == MODE_SENDER) { bsp_led_set(1, 0, level, level); bsp_led_set(5, 0, level, level); bsp_led_set(0, 0, level, level); }
        else                       { bsp_led_set(2, 0, level, level); bsp_led_set(3, 0, level, level); bsp_led_set(4, 0, level, level); }
    } else if (have_intent()) {
        int level = (s_mode == MODE_SENDER)
                  ? 55 + (int)((t % 1400) * 75 / 1400)
                  : 90 + (int)((t % 1400) * 165 / 1400);
        if (s_mode == MODE_SENDER) bsp_led_set_all(level, level, 0);
        else                       bsp_led_set_all(0, level, 45);
    } else if (s_mode == MODE_SENDER) {
        bsp_led_set_all(18, 8, 35);
    } else if (s_mode == MODE_MERCHANT) {
        bsp_led_set_all(0, 20, 10);
    }
    bsp_led_show();
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
static void paint(void)
{
    ui_model_t m = {0};
    int64_t t = now_ms();
    const splink_peer_t *p = splink_peer();
    bool paired   = splink_state() == SPLINK_PAIRED;
    bool near     = p != NULL;
    bool touching = p && p->rssi >= SPLINK_RSSI_GATE;

    if (s_mode == MODE_HOME) {
        m.screen = UI_SCREEN_HOME;
        m.home_selection = s_home_sel;
        ui_render(&m);
        return;
    }

    m.screen = (s_mode == MODE_SENDER) ? UI_SCREEN_SENDER : UI_SCREEN_MERCHANT;
    m.card_bg = UI_PANEL;
    m.card_border = UI_PURPLE;
    m.card_border_w = 2;

    // ---------------- sender ----------------
    if (s_mode == MODE_SENDER) {
        if (t < s_paid_until) {
            money(s_buf_kicker + 7, sizeof(s_buf_kicker) - 7, s_lamports);
            memcpy(s_buf_kicker, "PAID  ", 6); s_buf_kicker[6] = ' ';
            m.state = "PAID"; m.state_color = UI_GREEN;
            m.mode = "[ PAYMENT SENT ]"; m.mode_color = UI_GREEN;
            m.kicker = s_buf_kicker; m.kicker_color = UI_GREEN;
            m.value = s_item; m.detail = "WAITING FOR CONFIRMATION";
            m.card_bg = 0x143D30; m.card_border = UI_GREEN;
            m.card_text = "+ APPROVAL SENT +\nSENT TO TERMINAL\nVERIFYING ON SOLANA";
            m.footer = "HOME EXIT";
            ui_render(&m); return;
        }
        if (have_intent()) {
            char amt[24]; money(amt, sizeof(amt), s_lamports);
            snprintf(s_buf_kicker, sizeof(s_buf_kicker), "PAY  -  %s", amt);
            m.center_block = true;
            m.state = "REQUEST"; m.state_color = UI_YELLOW;
            m.mode = "[ PAYMENT REQUEST ]"; m.mode_color = UI_CYAN;
            m.kicker = s_buf_kicker; m.kicker_color = UI_PINK;
            m.value = s_item;

            if (s_confirming && paired) {
                snprintf(s_buf_card, sizeof(s_buf_card), "PAY %s\nTO %02X%02X\nA CONFIRM    B CANCEL",
                         amt, p ? p->mac[4] : 0, p ? p->mac[5] : 0);
                m.state = "CONFIRM"; m.state_color = UI_GREEN;
                m.detail = s_note[0] ? s_note : "PRESS A TO PAY THIS MERCHANT";
                m.card_border = UI_GREEN; m.card_border_w = 3;
                m.card_text = s_buf_card;
                m.footer = "A CONFIRM   B CANCEL   HOME EXIT";
            } else if (near) {
                m.detail = s_note[0] ? s_note
                         : (touching ? "BADGES ALIGNED - KNOCK NOW" : "< BRING TO MERCHANT LEFT EDGE");
                m.card_border = touching ? UI_GREEN : UI_CYAN; m.card_border_w = 3;
                m.card_text = touching ? "KNOCK TO PAIR" : "<<<  LEFT EDGE";
                m.footer = "B DECLINE   HOME EXIT";
            } else {
                m.detail = s_note[0] ? s_note : "CHECK ITEM AND AMOUNT";
                m.card_border = UI_YELLOW;
                m.card_text = "KNOCK ON MERCHANT\nTHEN A TO PAY";
                m.footer = "B DECLINE   HOME EXIT";
            }
            ui_render(&m); return;
        }
        m.state = "READY"; m.state_color = UI_PURPLE;
        m.mode = "[ SENDER ]"; m.mode_color = UI_DIM;
        m.kicker = "READY TO PAY"; m.kicker_color = UI_YELLOW;
        m.value = "-- SOL"; m.detail = "WAITING FOR A CHECKOUT";
        m.card_border = near ? UI_CYAN : UI_PURPLE; m.card_border_w = near ? 3 : 2;
        m.card_text = "HOW TO PAY\nHOLD NEAR CHECKOUT\nREVIEW, THEN PRESS A";
        m.footer = "HOME EXIT";
        ui_render(&m); return;
    }

    // ---------------- merchant ----------------
    if (t < s_result_until) {
        bool failed  = strcmp(s_result, "FAILED") == 0;
        bool settled = strcmp(s_result, "CONFIRMED") == 0;
        uint32_t c = failed ? UI_RED : (settled ? UI_GREEN : UI_YELLOW);
        char amt[24]; money(amt, sizeof(amt), s_lamports);
        snprintf(s_buf_card, sizeof(s_buf_card), "%s\n%s\n%s",
                 settled ? "+ PAYMENT CONFIRMED +" : (failed ? "! CHECK LAPTOP LOG !" : "+ APPROVAL RECEIVED +"),
                 s_payer_id[0] ? s_payer_id : "PAYER",
                 failed ? "TRANSACTION NOT SETTLED" : "VERIFYING ON SOLANA");
        m.state = failed ? "ERROR" : (settled ? "PAID" : "TAP"); m.state_color = c;
        m.mode = "[ PAYMENT LINK ]"; m.mode_color = c;
        m.kicker = failed ? "PAYMENT STOPPED" : (settled ? "SOLANA SETTLED" : "PAYER APPROVED");
        m.kicker_color = c;
        m.value = failed ? "FAILED" : (settled ? "CONFIRMED" : "SIGNING...");
        snprintf(s_buf_detail, sizeof(s_buf_detail), "%s", amt);
        m.detail = s_buf_detail;
        m.card_bg = failed ? 0x3D1420 : 0x143D30; m.card_border = c;
        m.card_text = s_buf_card;
        m.footer = "HOME EXIT";
        ui_render(&m); return;
    }
    if (have_intent()) {
        char amt[24]; money(amt, sizeof(amt), s_lamports);
        snprintf(s_buf_kicker, sizeof(s_buf_kicker), "PAYMENT  -  %s", amt);
        m.center_block = true;
        m.state = "LIVE"; m.state_color = UI_PINK;
        m.mode = "[ CHECKOUT READY ]"; m.mode_color = UI_CYAN;
        m.kicker = s_buf_kicker; m.kicker_color = UI_YELLOW;
        m.value = s_item;
        if (paired) {
            m.detail = s_note[0] ? s_note : "PAYER PAIRED";
            m.card_border = UI_GREEN; m.card_border_w = 3;
            m.card_text = "< CONFIRM ON PAYER >";
        } else if (near) {
            m.detail = s_note[0] ? s_note
                     : (touching ? "BADGES ALIGNED - KNOCK NOW" : "BRING SENDER TO RIGHT EDGE >");
            m.card_border = touching ? UI_GREEN : UI_CYAN; m.card_border_w = 3;
            m.card_text = touching ? "< KNOCK TO PAIR >" : "RIGHT EDGE  >>>";
        } else {
            m.detail = s_note[0] ? s_note : "WAITING FOR SENDER BADGE";
            m.card_border = UI_GREEN;
            m.card_text = "TAP ON RIGHT EDGE  >>>";
        }
        m.footer = "B CANCEL   HOME EXIT";
        ui_render(&m); return;
    }
    {
        bool online = spconsole_laptop_online();
        snprintf(s_buf_card, sizeof(s_buf_card), "$ SOLARPAY CHECKOUT $\n%s", s_badge_id);
        m.state = online ? "ONLINE" : "OFFLINE"; m.state_color = online ? UI_CYAN : UI_PURPLE;
        m.mode = online ? "[ USB RECEIVE MODE ]" : "[ MERCHANT ]"; m.mode_color = online ? UI_CYAN : UI_DIM;
        m.kicker = "READY TO SELL"; m.kicker_color = UI_YELLOW;
        m.value = "WAITING...";
        m.detail = online ? "CREATE A PAYMENT ON LAPTOP" : "CONNECT USB TO LAPTOP";
        m.card_border = near ? UI_CYAN : UI_PURPLE; m.card_border_w = near ? 3 : 2;
        m.card_text = s_buf_card;
        m.footer = "HOME EXIT";
        ui_render(&m);
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
    s_note[0] = '\0';
    if (splink_is_armed()) splink_disarm(SPLINK_CLOSE_CANCELLED);
    paint();
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
    char f[96];
    snprintf(f, sizeof(f), "peer_sid=%08" PRIx32 "|rssi=%d", p->sid, p->rssi);
    if (s_mode == MODE_SENDER) {
        s_confirming = true;
        s_note[0] = '\0';
    } else {
        spconsole_emit("peer_detected", f);
        snprintf(s_note, sizeof(s_note), "PAYER PAIRED - CONFIRM ON THEIR BADGE");
    }
    paint();
}

static void cb_ambiguous(int count, void *ctx)
{
    snprintf(s_note, sizeof(s_note), "TOO MANY BADGES - TRY AGAIN");
    if (s_mode == MODE_MERCHANT) {
        char f[48]; snprintf(f, sizeof(f), "reason=ambiguous_tap|count=%d", count);
        spconsole_emit("approval_ignored", f);
    }
    paint();
}

// Merchant only: an approval arriving over the authenticated link.
static void cb_message(const char *text, size_t len, void *ctx)
{
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
    splink_disarm(SPLINK_CLOSE_OK);
    paint();
}

static void cb_delivered(void *ctx)
{
    if (s_mode == MODE_SENDER) { snprintf(s_note, sizeof(s_note), "APPROVAL DELIVERED"); paint(); }
}

static void cb_send_failed(void *ctx)
{
    if (s_mode == MODE_SENDER) {
        s_paid_until = 0;
        snprintf(s_note, sizeof(s_note), "MERCHANT DID NOT ANSWER - PRESS A AGAIN");
        paint();
    }
}

static void cb_closed(splink_close_t why, void *ctx)
{
    s_confirming = false;
    snprintf(s_note, sizeof(s_note), "%s",
             why == SPLINK_CLOSE_EXPIRED ? "PAIRING WINDOW CLOSED" : "LINK CLOSED");
    paint();
}

// Sender only: the merchant's plaintext checkout broadcast. Deliberately
// outside the link -- the payer must be able to read the amount before tapping.
static void cb_broadcast(const char *text, size_t len, const uint8_t mac[6], int8_t rssi, void *ctx)
{
    // A badge sitting on the home screen that hears a live checkout is, by
    // definition, a payer standing at a till. Entering sender mode on its own
    // is what makes the sender a cable-free device: nothing to press, nothing
    // to connect, it just shows the amount.
    if (s_mode == MODE_HOME && strncmp(text, "SP1:I:", 6) == 0) {
        s_mode = MODE_SENDER;
        s_home_sel = 0;
        splink_set_role(SPLINK_ROLE_SENDER);
        ESP_LOGI(TAG, "entering SENDER mode (checkout heard over the air)");
    }
    if (s_mode != MODE_SENDER) return;
    if (strncmp(text, "SP1:M:", 6) == 0) { parse_item(text); paint(); return; }
    if (strncmp(text, "SP1:I:", 6) != 0) return;

    char prev[33]; snprintf(prev, sizeof(prev), "%s", s_intent);
    if (!parse_intent(text)) return;
    bool fresh = strcmp(prev, s_intent) != 0;
    if (fresh) {
        strcpy(s_item, "PAYMENT");
        s_confirming = false;
        s_paid_until = 0;
        // A payment request is the only thing that opens a pairing window.
        if (!splink_is_armed()) {
            splink_arm();
            snprintf(s_note, sizeof(s_note), "KNOCK ON THE MERCHANT BADGE");
        }
        ESP_LOGI(TAG, "checkout %s for %" PRIu64 " lamports", s_intent, s_lamports);
    }
    paint();
}

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
    splink_set_role(SPLINK_ROLE_MERCHANT);
    spconsole_emit("app_enter", s_badge_id);
    ESP_LOGI(TAG, "entering MERCHANT mode (checkout arrived over USB)");
}

static void on_intent_line(const char *pkt, void *ctx)
{
    enter_merchant_if_needed();
    if (!parse_intent(pkt)) { spconsole_emit("intent_load_failed", "reason=invalid_format"); return; }
    snprintf(s_intent_packet, sizeof(s_intent_packet), "%s", pkt);
    s_approved_intent[0] = '\0';
    s_result_until = 0;
    s_next_bcast = 0;
    uint32_t sid = splink_arm();
    char f[96];
    snprintf(f, sizeof(f), "intent=%s|sid=%08" PRIx32, s_intent, sid);
    spconsole_emit("link_armed", f);
    snprintf(f, sizeof(f), "intent=%s|lamports=%" PRIu64, s_intent, s_lamports);
    spconsole_emit("intent_loaded", f);
    snprintf(f, sizeof(f), "intent=%s", s_intent);
    spconsole_emit("broadcast_requested", f);
    snprintf(s_note, sizeof(s_note), "WAITING FOR PAYER");
    paint();
}

static void on_item_line(const char *pkt, void *ctx)
{
    enter_merchant_if_needed();
    snprintf(s_item_packet, sizeof(s_item_packet), "%s", pkt);
    parse_item(pkt);
    paint();
}

static void on_confirm_line(const char *intent, void *ctx)
{
    if (s_mode != MODE_MERCHANT) return;
    strcpy(s_result, "CONFIRMED");
    s_result_started = now_ms(); s_result_until = s_result_started + 5000;
    char f[64]; snprintf(f, sizeof(f), "intent=%s", intent);
    spconsole_emit("settlement_confirmed", f);
    s_intent[0] = '\0'; s_intent_packet[0] = '\0'; s_item_packet[0] = '\0';
    paint();
}

static void on_fail_line(const char *intent, void *ctx)
{
    if (s_mode != MODE_MERCHANT) return;
    strcpy(s_result, "FAILED");
    s_result_started = now_ms(); s_result_until = s_result_started + 5000;
    char f[64]; snprintf(f, sizeof(f), "intent=%s", intent);
    spconsole_emit("settlement_failed", f);
    s_intent[0] = '\0'; s_intent_packet[0] = '\0'; s_item_packet[0] = '\0';
    paint();
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
        paint();
        return;
    }
    if (splink_is_sending()) return;

    char msg[SPLINK_MAX_MESSAGE];
    int n = snprintf(msg, sizeof(msg), "A:%s:%s:%s", s_intent, s_badge_id, s_nonce);
    if (splink_send_message(msg, (size_t)n) != ESP_OK) {
        snprintf(s_note, sizeof(s_note), "COULD NOT SEND - TRY AGAIN");
        paint();
        return;
    }
    s_paid_started = now_ms();
    s_paid_until   = s_paid_started + 3000;
    snprintf(s_note, sizeof(s_note), "SENDING APPROVAL...");
    paint();
}

static void on_button(bsp_btn_t btn, bsp_btn_edge_t edge, void *ctx)
{
    if (edge != BSP_BTN_PRESSED) return;

    if (s_mode == MODE_HOME) {
        if (btn == BSP_BTN_LEFT)  { s_home_sel = 0; paint(); }
        if (btn == BSP_BTN_RIGHT) { s_home_sel = 1; paint(); }
        if (btn == BSP_BTN_A || btn == BSP_BTN_START) {
            s_mode = s_home_sel == 0 ? MODE_SENDER : MODE_MERCHANT;
            splink_set_role(s_home_sel == 0 ? SPLINK_ROLE_SENDER : SPLINK_ROLE_MERCHANT);
            if (s_mode == MODE_MERCHANT) spconsole_emit("app_enter", s_badge_id);
            ESP_LOGI(TAG, "mode: %s", s_mode == MODE_SENDER ? "SENDER" : "MERCHANT");
            paint();
        }
        return;
    }

    if (btn == BSP_BTN_HOME) {
        clear_intent(NULL);
        s_mode = MODE_HOME;
        s_result_until = s_paid_until = 0;
        bsp_led_clear(); bsp_led_show();
        paint();
        return;
    }

    if (s_mode == MODE_SENDER) {
        if (btn == BSP_BTN_A && have_intent()) approve();
        else if (btn == BSP_BTN_B && have_intent()) clear_intent("intent_declined");
    } else {
        if (btn == BSP_BTN_B && have_intent()) clear_intent("intent_cancelled");
    }
}

// ---------------------------------------------------------------------------
void app_main(void)
{
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_badge_id, sizeof(s_badge_id), "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

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
    };
    spconsole_init(&ccbs, "merchant");

    splink_cbs_t lcbs = {
        .on_paired      = cb_paired,
        .on_ambiguous   = cb_ambiguous,
        .on_message     = cb_message,
        .on_delivered   = cb_delivered,
        .on_send_failed = cb_send_failed,
        .on_closed      = cb_closed,
        .on_impact      = cb_impact,
    };
    ESP_ERROR_CHECK(splink_init(SPLINK_ROLE_SENDER, &lcbs));
    splink_set_broadcast_handler(cb_broadcast, NULL);

    paint();

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

        // Merchant rebroadcasts the checkout so any sender in range can read the
        // amount. This is plaintext and outside the link, on purpose.
        if (s_mode == MODE_MERCHANT && s_intent_packet[0] && t < s_expires_ms && t >= s_next_bcast) {
            s_next_bcast = t + 450;
            splink_broadcast(s_intent_packet, strlen(s_intent_packet));
            if (s_item_packet[0]) splink_broadcast(s_item_packet, strlen(s_item_packet));
        }

        if (have_intent() && t >= s_expires_ms) clear_intent("intent_expired");
        if (s_paid_until && t >= s_paid_until && !splink_is_sending()) {
            s_paid_until = 0;
            clear_intent(NULL);
        }

        if (t >= next_led)  { next_led = t + 75; render_leds(); }
        if (t >= next_paint) { next_paint = t + 200; paint(); }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

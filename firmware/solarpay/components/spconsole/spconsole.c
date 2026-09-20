#include "spconsole.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define LINE_MAX 256
// The laptop is considered present for this long after anything it sends.
#define LAPTOP_TTL_MS 45000

static spconsole_cbs_t s_cbs;
static const char     *s_role = "merchant";
static unsigned        s_seq;
static int64_t         s_laptop_until;

static inline int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

static void handle_line(char *line)
{
    // Strip trailing CR/LF and whitespace.
    size_t n = strlen(line);
    while (n && (line[n-1] == '\r' || line[n-1] == '\n' || line[n-1] == ' ')) line[--n] = '\0';
    if (!n) return;

    s_laptop_until = now_ms() + LAPTOP_TTL_MS;

    if (strncmp(line, "SP_INTENT ", 10) == 0) {
        if (s_cbs.on_intent) s_cbs.on_intent(line + 10, s_cbs.ctx);
    } else if (strncmp(line, "SP_ITEM ", 8) == 0) {
        if (s_cbs.on_item) s_cbs.on_item(line + 8, s_cbs.ctx);
    } else if (strncmp(line, "SP_CONFIRM ", 11) == 0) {
        if (s_cbs.on_confirm) s_cbs.on_confirm(line + 11, s_cbs.ctx);
    } else if (strncmp(line, "SP_FAIL ", 8) == 0) {
        if (s_cbs.on_fail) s_cbs.on_fail(line + 8, s_cbs.ctx);
    } else if (strncmp(line, "SP_WALLET ", 10) == 0) {
        char addr[64]; unsigned long long lamports = 0;
        if (sscanf(line + 10, "%63s %llu", addr, &lamports) >= 1 && s_cbs.on_wallet) {
            s_cbs.on_wallet(addr, (uint64_t)lamports, s_cbs.ctx);
        }
    } else if (strcmp(line, "SP_ID") == 0) {
        if (s_cbs.on_id_request) s_cbs.on_id_request(s_cbs.ctx);
    } else if (strcmp(line, "SP_PING") == 0) {
        spconsole_emit("laptop_connected", NULL);
#if CONFIG_SOLARPAY_TEST_HARNESS
    } else if (strncmp(line, "SP_TEST_IMPACT ", 15) == 0) {
        if (s_cbs.on_test_impact) s_cbs.on_test_impact((uint16_t)strtoul(line + 15, NULL, 10), s_cbs.ctx);
    } else if (strncmp(line, "SP_TEST_BTN ", 12) == 0) {
        if (s_cbs.on_test_btn) s_cbs.on_test_btn(line + 12, s_cbs.ctx);
    } else if (strcmp(line, "SP_TEST_STATE") == 0) {
        if (s_cbs.on_test_state) s_cbs.on_test_state(s_cbs.ctx);
    } else if (strcmp(line, "SP_TEST_REBOOT") == 0) {
        if (s_cbs.on_test_reboot) s_cbs.on_test_reboot(s_cbs.ctx);
#endif
    }
}

static void console_task(void *arg)
{
    static char line[LINE_MAX];
    size_t len = 0;
    uint8_t chunk[64];

    for (;;) {
        int got = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), pdMS_TO_TICKS(50));
        for (int i = 0; i < got; i++) {
            char c = (char)chunk[i];
            // The stock console used a bare CR; accept either terminator.
            if (c == '\n' || c == '\r') {
                line[len] = '\0';
                handle_line(line);
                len = 0;
            } else if (len < LINE_MAX - 1) {
                line[len++] = c;
            } else {
                len = 0;   // overlong line: drop it rather than truncate silently
            }
        }
    }
}

void spconsole_init(const spconsole_cbs_t *cbs, const char *role)
{
    if (cbs) s_cbs = *cbs;
    if (role) s_role = role;

    usb_serial_jtag_driver_config_t cfg = {
        .tx_buffer_size = 1024,
        .rx_buffer_size = 1024,
    };
    // Harmless if the console driver is already installed by the logging path.
    usb_serial_jtag_driver_install(&cfg);

    xTaskCreate(console_task, "spconsole", 3072, NULL, 5, NULL);
}

void spconsole_set_role(const char *role)
{
    if (role) s_role = role;
}

void spconsole_emit(const char *kind, const char *fields)
{
    s_seq++;
    if (fields && *fields) {
        printf("SP_EVT|v=3|seq=%u|role=%s|type=%s|%s\n", s_seq, s_role, kind, fields);
    } else {
        printf("SP_EVT|v=3|seq=%u|role=%s|type=%s\n", s_seq, s_role, kind);
    }
    fflush(stdout);
}

void spconsole_approval(const char *intent, const char *badge_id, const char *nonce)
{
    printf("SOLARPAY_APPROVAL:SP1:A:%s:%s:%s\n", intent, badge_id, nonce);
    fflush(stdout);
}

void spconsole_identity(const char *role, const char *badge_id)
{
    printf("SOLARPAY_BADGE:%s:%s\n", role, badge_id);
    fflush(stdout);
}

bool spconsole_laptop_online(void)
{
    return now_ms() < s_laptop_until;
}

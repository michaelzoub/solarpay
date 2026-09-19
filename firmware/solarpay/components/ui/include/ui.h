// The SolarPay screens, ported from the Lua apps badges/solarpay_customer.lua
// and badges/solarpay_merchant.lua. Palette, copy, layout, LED behaviour and
// state names are carried over deliberately: this is the same product, drawn
// natively instead of through the badge's Lua UI bindings.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// The palette from the Lua apps, verbatim.
#define UI_INK    0x10091F
#define UI_PANEL  0x21143D
#define UI_PURPLE 0x9A5CFF
#define UI_PINK   0xFF4FD8
#define UI_CYAN   0x4DEBFF
#define UI_GREEN  0x55F991
#define UI_YELLOW 0xFFE45E
#define UI_RED    0xFF304F
#define UI_WHITE  0xFFF8FF
#define UI_SOFT   0xC5AFDD
#define UI_DIM    0x806B9A

typedef enum {
    UI_SCREEN_HOME = 0,
    UI_SCREEN_SENDER,
    UI_SCREEN_MERCHANT,
} ui_screen_t;

// Everything the screens draw, in one struct, so rendering is a pure function
// of state and there is no hidden UI bookkeeping to get out of step.
typedef struct {
    ui_screen_t screen;

    // Home
    int  home_selection;      // 0 = sender, 1 = merchant

    // Shared chrome
    const char *mode;         // "[ CHECKOUT READY ]"
    uint32_t    mode_color;
    const char *state;        // "LIVE", "CONFIRM", "PAID"
    uint32_t    state_color;

    const char *kicker;
    uint32_t    kicker_color;
    const char *value;
    const char *detail;

    const char *card_text;
    uint32_t    card_bg;
    uint32_t    card_border;
    int         card_border_w;

    const char *footer;

    bool        center_block; // intent screens centre the kicker/value/detail
} ui_model_t;

// Builds every widget once. Call after bsp_display_init().
void ui_init(void);
// Applies the model to the widgets. Safe to call every frame; takes the LVGL lock.
void ui_render(const ui_model_t *m);

#ifdef __cplusplus
}
#endif

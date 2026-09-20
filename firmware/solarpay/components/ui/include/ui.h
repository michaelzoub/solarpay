// The SolarPay screens.
//
// Visual direction: minimal, premium, playful consumer fintech. Light purple
// paper, black type, soft pastel mint and sky accents, large rounded surfaces
// and a lot of air. Deliberately not a POS terminal.
//
// Layout, text and cards are LVGL. The badge-to-badge moment is not: that is a
// living orb drawn pixel by pixel into its own RGB565 canvas by orb.c, on its
// own 30 fps timer, independent of the 5 Hz model repaint. See orb.h for why
// it is a 128x128 island rather than the whole screen.
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
// Black type on light purple inverts the usual glow problem: additive light
// reads as dirt on a light background, so the orb uses soft alpha penumbra and
// tinted shadow instead of add-blending. Every accent below is a pastel chosen
// to stay legible *under* black text, so nothing needs a second foreground
// token.
//
// These six and the two purples below are the same values the website ships in
// web/styles.css. Change one, change the other: the badge in your hand and the
// checkout on screen are one product. The neutrals carry a violet cast on
// purpose -- the old warm greys, tuned for cream, silt up against lavender.
#define UI_PAPER     0xF3EFFC   // screen background, light purple
#define UI_CARD      0xFCFAFF   // raised surfaces
#define UI_HAIRLINE  0xE5DDF7   // the only border we ever draw
#define UI_INK       0x0A0A0B   // all primary type
#define UI_INK_SOFT  0x6B6479   // labels, footers, secondary
#define UI_INK_FAINT 0x9C94AE   // disabled, placeholders

#define UI_MINT      0xA8E6C4   // success, merchant accent
#define UI_MINT_DEEP 0x1E7A4F   // mint-on-paper text when it must carry weight
#define UI_SKY       0xAFD9F0   // active/live, sender accent
#define UI_SKY_DEEP  0x1C6C93
#define UI_CORAL     0xFFB4A8   // failure -- soft, never a system red
#define UI_CORAL_DEEP 0xA33323
#define UI_BUTTER    0xFFE9B0   // pending, awaiting a human

#define UI_PURPLE_SOFT 0xC9B6F5 // the light purple itself: card edges, fills
#define UI_PURPLE_DEEP 0x5B2FC9 // purple-on-paper text when it must carry weight

// The pre-redesign names, mapped onto the new palette so any call site that
// still speaks the old vocabulary keeps its meaning rather than its hue.
#define UI_PANEL   UI_CARD
#define UI_PURPLE  UI_PURPLE_SOFT
#define UI_PINK    UI_SKY_DEEP
#define UI_CYAN    UI_SKY_DEEP
#define UI_GREEN   UI_MINT_DEEP
#define UI_YELLOW  UI_INK_SOFT
#define UI_RED     UI_CORAL_DEEP
#define UI_WHITE   UI_INK
#define UI_SOFT    UI_INK_SOFT
#define UI_DIM     UI_INK_FAINT

// The checkmark, as LV_SYMBOL_OK encodes it: U+F00C from the FontAwesome
// subset every built-in Montserrat here carries. Spelled out so a caller can
// name the glyph without taking a dependency on LVGL's headers, which is the
// same reason nothing else in this header mentions LVGL either.
#define UI_GLYPH_OK "\xEF\x80\x8C"

typedef enum {
    UI_SCREEN_HOME = 0,
    UI_SCREEN_SENDER,
    UI_SCREEN_MERCHANT,
} ui_screen_t;

// What the orb is doing. The UI layer eases between these; callers just state
// the truth every repaint and never drive the animation themselves.
typedef enum {
    UI_ORB_OFF = 0,   // no orb on this screen
    UI_ORB_CALM,      // idle: one slow blob, doubles as the screensaver
    UI_ORB_SEEKING,   // armed, nobody found yet: searching pulse
    UI_ORB_NEAR,      // a peer is visible; orb_proximity drives everything
    UI_ORB_MERGED,    // paired: the two shapes snap into one
    UI_ORB_SUCCESS,   // mint bloom + particles
    UI_ORB_CONFIRMED, // the bloom settles and a checkmark strokes itself on
    UI_ORB_FAILURE,   // coral, one slow collapse
} ui_orb_state_t;

// Everything the screens draw, in one struct, so rendering is a pure function
// of state and there is no hidden UI bookkeeping to get out of step.
typedef struct {
    ui_screen_t screen;

    // Home
    int  home_selection;      // 0 = sender, 1 = merchant

    // Chrome
    const char *mode;         // small uppercase label, top left
    uint32_t    mode_color;
    const char *state;        // pill, top right
    uint32_t    state_color;  // pill fill; text is always ink

    // The hero block. `value` is the oversized line -- put the amount here.
    const char *kicker;       // small label above the hero
    uint32_t    kicker_color;
    const char *value;        // 40pt
    const char *detail;       // sub-label under the hero

    // The card. Kept for the secondary block under the hero.
    const char *card_text;
    uint32_t    card_bg;
    uint32_t    card_border;
    int         card_border_w;

    // The primary action, drawn as a filled pill at the bottom -- the one
    // button press this screen is asking for, e.g. "A   Pay". The footer is a
    // hint; this is an affordance, and it is the only thing on screen allowed
    // to compete with the orb. Leave it NULL on screens that are not waiting
    // on a deliberate press.
    const char *action;
    uint32_t    action_color; // pill fill; the text is always ink

    // Secondary keys only -- "B  cancel", "HOME  done". Never the primary act.
    const char *footer;

    // The orb island.
    ui_orb_state_t orb;
    uint8_t        orb_proximity;  // 0 far .. 255 touching; only read in NEAR
} ui_model_t;

// Builds every widget once. Call after bsp_display_init().
void ui_init(void);
// Applies the model to the widgets. Safe to call every frame; takes the LVGL lock.
void ui_render(const ui_model_t *m);

// Tell the UI it is running on battery, so the animated parts can hold
// themselves to a smaller standing load. See orb_set_frugal() for the measured
// reason this exists. Safe to call every loop; only a change does any work.
void ui_set_frugal(bool frugal);

#ifdef __cplusplus
}
#endif

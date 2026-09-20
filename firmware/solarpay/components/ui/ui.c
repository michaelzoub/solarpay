// SolarPay screens: LVGL owns layout, type and cards; orb.c owns the moment.
//
// Two layouts, picked by whether the model asks for an orb.
//
//   "statement"  no orb. A small chrome row, then one oversized line carrying
//                the amount, then a white card. Used for idle and result.
//   "moment"     the orb is the screen. Chrome row, 128x128 orb, a compact
//                amount under it, one line of guidance. The card is hidden --
//                during pairing there is nothing to read, only something to do.
//
// Nothing here animates per-frame. The orb runs its own 30 fps timer and LVGL
// is not asked to redraw while it does, which is what keeps the frame rate
// stable; the only LVGL animation is the 200 ms home-selection slide.
#include "ui.h"

#include <string.h>

#include "bsp.h"
#include "lvgl.h"
#include "orb.h"

#include "esp_log.h"

#define TTAG "spflow"

#define PAD_X 16

static lv_obj_t *s_shell;
static lv_obj_t *s_mode, *s_pill, *s_pill_text;
static lv_obj_t *s_kicker, *s_value, *s_detail;
static lv_obj_t *s_card, *s_card_text, *s_footer;
static lv_obj_t *s_action, *s_action_text;
static lv_obj_t *s_orb;

static lv_obj_t *s_home_box, *s_home_hl, *s_home_sender, *s_home_merchant, *s_home_hint, *s_brand;

static int s_last_home_sel = -1;
// -1 so the first render always applies a layout: the hero labels are created
// unaligned, and with a plain `false` the first statement screen matched
// s_last_moment, skipped the block, and drew kicker/value/detail stacked at
// the shell's top-left corner until something switched to the orb and back.
static int s_last_moment = -1;

// Last value pushed into each widget, so a repaint that changes nothing costs
// nothing. Sized to the widest string the model can carry for that slot.
static char s_c_mode[32], s_c_pill[32], s_c_kicker[32];
static char s_c_value[32], s_c_detail[64], s_c_card[160], s_c_footer[48];
static char s_c_action[32];
static uint32_t s_c_action_col;
static int s_last_action = -1;
static uint32_t s_c_mode_col, s_c_pill_col, s_c_kicker_col;
static uint32_t s_c_card_bg, s_c_card_border, s_c_card_border_w = 0xFFFFFFFF;

// LVGL invalidates on every setter call, whether or not the value actually
// changed. ui_render() is documented as safe to call every frame and restates
// the whole model each time, so setting unconditionally re-blitted the entire
// text layer at the repaint rate -- for nothing, on every screen, forever. That
// is wasted SPI DMA and CPU on a badge whose power budget is tight enough to
// brown out. Set only on a real change; most frames change nothing.
static bool changed_text(char *cache, size_t n, const char *s)
{
    if (!s) s = "";
    if (strncmp(cache, s, n - 1) == 0) return false;
    snprintf(cache, n, "%s", s);
    return true;
}

static void set_text(lv_obj_t *o, char *cache, size_t n, const char *s)
{
    if (changed_text(cache, n, s)) lv_label_set_text(o, s ? s : "");
}

static bool changed_u32(uint32_t *cache, uint32_t v)
{
    if (*cache == v) return false;
    *cache = v;
    return true;
}

static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, uint32_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, LV_PART_MAIN);
    lv_obj_set_style_text_color(l, lv_color_hex(color), LV_PART_MAIN);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    return l;
}

// A white surface with a hairline and a soft lift. The only chrome in the UI.
static void surface(lv_obj_t *o, int radius)
{
    lv_obj_set_style_bg_color(o, lv_color_hex(UI_CARD), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_radius(o, radius, LV_PART_MAIN);
    lv_obj_set_style_border_color(o, lv_color_hex(UI_HAIRLINE), LV_PART_MAIN);
    lv_obj_set_style_border_width(o, 1, LV_PART_MAIN);
    lv_obj_set_style_pad_all(o, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(o, 10, LV_PART_MAIN);
    lv_obj_set_style_shadow_offset_y(o, 3, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(o, lv_color_hex(0xD8D0C6), LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(o, LV_OPA_40, LV_PART_MAIN);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
}

void ui_init(void)
{
    bsp_display_lock(2000);

    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_hex(UI_PAPER), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_pad_all(scr, 0, LV_PART_MAIN);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    s_shell = lv_obj_create(scr);
    lv_obj_set_size(s_shell, BSP_LCD_H_RES, BSP_LCD_V_RES);
    lv_obj_center(s_shell);
    lv_obj_set_style_bg_color(s_shell, lv_color_hex(UI_PAPER), LV_PART_MAIN);
    lv_obj_set_style_border_width(s_shell, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(s_shell, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_shell, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(s_shell, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_shell, LV_OBJ_FLAG_SCROLLABLE);

    // --- chrome row ---------------------------------------------------------
    s_mode = label(s_shell, &lv_font_montserrat_14, UI_INK_SOFT);
    lv_obj_align(s_mode, LV_ALIGN_TOP_LEFT, PAD_X, 12);

    s_pill = lv_obj_create(s_shell);
    lv_obj_set_size(s_pill, LV_SIZE_CONTENT, 24);
    lv_obj_align(s_pill, LV_ALIGN_TOP_RIGHT, -PAD_X, 8);
    lv_obj_set_style_radius(s_pill, LV_RADIUS_CIRCLE, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_pill, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(s_pill, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_hor(s_pill, 12, LV_PART_MAIN);
    lv_obj_set_style_pad_ver(s_pill, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_pill, LV_OBJ_FLAG_SCROLLABLE);
    s_pill_text = label(s_pill, &lv_font_montserrat_14, UI_INK);
    lv_obj_center(s_pill_text);

    // --- the orb island -----------------------------------------------------
    s_orb = orb_attach(s_shell);
    if (s_orb) lv_obj_align(s_orb, LV_ALIGN_TOP_MID, 0, 28);

    // --- hero block ---------------------------------------------------------
    s_kicker = label(s_shell, &lv_font_montserrat_14, UI_INK_SOFT);
    s_value  = label(s_shell, &lv_font_montserrat_40, UI_INK);
    s_detail = label(s_shell, &lv_font_montserrat_14, UI_INK_SOFT);

    // --- card ---------------------------------------------------------------
    s_card = lv_obj_create(s_shell);
    lv_obj_set_size(s_card, 288, 74);
    lv_obj_align(s_card, LV_ALIGN_BOTTOM_MID, 0, -34);
    surface(s_card, 20);
    s_card_text = label(s_card, &lv_font_montserrat_14, UI_INK);
    lv_obj_center(s_card_text);

    // --- the primary action -------------------------------------------------
    // A filled pill, because the press that moves money cannot be a hint. It
    // was one: the confirm screen asked for it in the footer, at 14pt in
    // UI_INK_FAINT -- the token this palette reserves for disabled text -- at
    // the bottom edge, while a 128px animated orb held the top of the screen.
    // Payers bumping the badges together did not see it at all.
    s_action = lv_obj_create(s_shell);
    lv_obj_set_size(s_action, LV_SIZE_CONTENT, 46);
    lv_obj_set_style_radius(s_action, LV_RADIUS_CIRCLE, LV_PART_MAIN);
    // Light purple, the same #c9b6f5 the website fills its primary control
    // with. It also happens to be the stronger choice here: it sits further
    // from the paper than mint does, so the pill carries more contrast, not
    // less, for being the quieter colour.
    lv_obj_set_style_bg_color(s_action, lv_color_hex(UI_PURPLE_SOFT), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_action, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_action, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_hor(s_action, 26, LV_PART_MAIN);
    lv_obj_set_style_pad_ver(s_action, 0, LV_PART_MAIN);
    // The same soft lift the cards get, so it sits above the paper rather than
    // being painted onto it.
    lv_obj_set_style_shadow_width(s_action, 12, LV_PART_MAIN);
    lv_obj_set_style_shadow_offset_y(s_action, 4, LV_PART_MAIN);
    lv_obj_set_style_shadow_color(s_action, lv_color_hex(0xB9A9E0), LV_PART_MAIN);
    lv_obj_set_style_shadow_opa(s_action, LV_OPA_50, LV_PART_MAIN);
    lv_obj_remove_flag(s_action, LV_OBJ_FLAG_SCROLLABLE);
    // Set at the same 28pt as the amount above it. The action and the number
    // are the two things on this screen, and neither outranks the other: you
    // are being told what it costs and asked to agree to it.
    s_action_text = label(s_action, &lv_font_montserrat_28, UI_INK);
    lv_obj_center(s_action_text);

    s_footer = label(s_shell, &lv_font_montserrat_14, UI_INK_FAINT);
    lv_obj_align(s_footer, LV_ALIGN_BOTTOM_MID, 0, -10);

    // --- home ---------------------------------------------------------------
    s_brand = label(s_shell, &lv_font_montserrat_28, UI_INK);
    lv_label_set_text(s_brand, "solarpay");
    lv_obj_align(s_brand, LV_ALIGN_TOP_MID, 0, 26);

    s_home_box = lv_obj_create(s_shell);
    lv_obj_set_size(s_home_box, 300, 116);
    lv_obj_align(s_home_box, LV_ALIGN_TOP_MID, 0, 84);
    lv_obj_set_style_bg_opa(s_home_box, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_home_box, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(s_home_box, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_home_box, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_home_box, LV_OBJ_FLAG_SCROLLABLE);

    // The selection is a pastel slab that slides between the two cards, rather
    // than a border that blinks on and off. It is the only LVGL animation.
    s_home_hl = lv_obj_create(s_home_box);
    lv_obj_set_size(s_home_hl, 146, 116);
    lv_obj_set_pos(s_home_hl, 0, 0);
    lv_obj_set_style_radius(s_home_hl, 24, LV_PART_MAIN);
    lv_obj_set_style_bg_color(s_home_hl, lv_color_hex(UI_SKY), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(s_home_hl, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_home_hl, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(s_home_hl, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_home_hl, LV_OBJ_FLAG_SCROLLABLE);

    s_home_sender = lv_obj_create(s_home_box);
    lv_obj_set_size(s_home_sender, 138, 108);
    lv_obj_align(s_home_sender, LV_ALIGN_LEFT_MID, 4, 0);
    lv_obj_set_style_bg_opa(s_home_sender, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_home_sender, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(s_home_sender, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_home_sender, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_t *ls = label(s_home_sender, &lv_font_montserrat_20, UI_INK);
    lv_label_set_text(ls, "Send");
    lv_obj_align(ls, LV_ALIGN_CENTER, 0, -10);
    lv_obj_t *ls2 = label(s_home_sender, &lv_font_montserrat_14, UI_INK_SOFT);
    lv_label_set_text(ls2, "pay a merchant");
    lv_obj_align(ls2, LV_ALIGN_CENTER, 0, 16);

    s_home_merchant = lv_obj_create(s_home_box);
    lv_obj_set_size(s_home_merchant, 138, 108);
    lv_obj_align(s_home_merchant, LV_ALIGN_RIGHT_MID, -4, 0);
    lv_obj_set_style_bg_opa(s_home_merchant, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_home_merchant, 0, LV_PART_MAIN);
    lv_obj_set_style_shadow_width(s_home_merchant, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_home_merchant, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_t *lm = label(s_home_merchant, &lv_font_montserrat_20, UI_INK);
    lv_label_set_text(lm, "Merchant");
    lv_obj_align(lm, LV_ALIGN_CENTER, 0, -10);
    lv_obj_t *lm2 = label(s_home_merchant, &lv_font_montserrat_14, UI_INK_SOFT);
    lv_label_set_text(lm2, "take a payment");
    lv_obj_align(lm2, LV_ALIGN_CENTER, 0, 16);

    s_home_hint = label(s_shell, &lv_font_montserrat_14, UI_INK_FAINT);
    lv_obj_align(s_home_hint, LV_ALIGN_BOTTOM_MID, 0, -14);
    lv_label_set_text(s_home_hint, "‹ ›  choose      A  start");

    bsp_display_unlock();
}

static void show(lv_obj_t *o, bool visible)
{
    if (!o) return;
    if (visible) lv_obj_remove_flag(o, LV_OBJ_FLAG_HIDDEN);
    else         lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN);
}

static void hl_x_cb(void *var, int32_t v) { lv_obj_set_x((lv_obj_t *)var, v); }

static void render_home(const ui_model_t *m)
{
    show(s_brand, true);
    show(s_home_box, true);
    show(s_home_hint, true);

    if (m->home_selection != s_last_home_sel) {
        int32_t from = (s_last_home_sel == 1) ? 154 : 0;
        int32_t to   = (m->home_selection == 1) ? 154 : 0;

        lv_obj_set_style_bg_color(s_home_hl,
            lv_color_hex(m->home_selection == 1 ? UI_MINT : UI_SKY), LV_PART_MAIN);

        if (s_last_home_sel < 0) {
            lv_obj_set_x(s_home_hl, to);
        } else {
            lv_anim_t a;
            lv_anim_init(&a);
            lv_anim_set_var(&a, s_home_hl);
            lv_anim_set_exec_cb(&a, hl_x_cb);
            lv_anim_set_values(&a, from, to);
            lv_anim_set_duration(&a, 220);
            lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
            lv_anim_start(&a);
        }
        s_last_home_sel = m->home_selection;
    }
}

void ui_set_frugal(bool frugal)
{
    orb_set_frugal(frugal);
}

void ui_render(const ui_model_t *m)
{
    if (!bsp_display_lock(60)) return;

    bool home = (m->screen == UI_SCREEN_HOME);
    static int s_was_home = -1;
    if ((int)home != s_was_home) {
        ESP_LOGI(TTAG, "ui screen %s -> %s", s_was_home == 1 ? "home" : "app",
                 home ? "home" : "app");
        s_was_home = (int)home;
    }

    if (home) {
        show(s_mode, false); show(s_pill, false);
        show(s_kicker, false); show(s_value, false); show(s_detail, false);
        show(s_card, false); show(s_footer, false); show(s_action, false);
        orb_set(UI_ORB_OFF, 0);
        render_home(m);
        bsp_display_unlock();
        return;
    }

    show(s_brand, false);
    show(s_home_box, false);
    show(s_home_hint, false);
    s_last_home_sel = -1;

    bool moment = (m->orb != UI_ORB_OFF);
    bool action = m->action && m->action[0];

    show(s_mode, true);
    show(s_pill, true);
    show(s_value, true);
    show(s_detail, true);
    show(s_footer, true);
    show(s_action, action);
    show(s_kicker, !moment);
    // The card and the action pill both want the bottom of the screen, and on
    // a 240 px panel only one of them fits under the hero. The pill wins: a
    // card that says "press A, then knock" is instructions for the thing the
    // pill already is.
    show(s_card, !moment && !action);

    orb_set(m->orb, m->orb_proximity);

    set_text(s_mode, s_c_mode, sizeof(s_c_mode), m->mode);
    if (changed_u32(&s_c_mode_col, m->mode_color ? m->mode_color : UI_INK_SOFT)) {
        lv_obj_set_style_text_color(s_mode, lv_color_hex(s_c_mode_col), LV_PART_MAIN);
    }

    set_text(s_pill_text, s_c_pill, sizeof(s_c_pill), m->state);
    if (changed_u32(&s_c_pill_col, m->state_color ? m->state_color : UI_HAIRLINE)) {
        lv_obj_set_style_bg_color(s_pill, lv_color_hex(s_c_pill_col), LV_PART_MAIN);
    }

    set_text(s_kicker, s_c_kicker, sizeof(s_c_kicker), m->kicker);
    if (changed_u32(&s_c_kicker_col, m->kicker_color ? m->kicker_color : UI_INK_SOFT)) {
        lv_obj_set_style_text_color(s_kicker, lv_color_hex(s_c_kicker_col), LV_PART_MAIN);
    }
    set_text(s_value, s_c_value, sizeof(s_c_value), m->value);
    set_text(s_detail, s_c_detail, sizeof(s_c_detail), m->detail);

    // Only re-lay-out when the layout actually changes: moving labels every
    // repaint invalidates regions LVGL would otherwise leave alone. The action
    // pill is part of that identity, because claiming the bottom 38 px pushes
    // everything above it up.
    if ((int)moment != s_last_moment || (int)action != s_last_action) {
        ESP_LOGI(TTAG, "ui layout %s -> %s%s",
                 s_last_moment < 0 ? "(init)" : s_last_moment ? "moment" : "statement",
                 moment ? "moment" : "statement", action ? "+action" : "");
        if (moment) {
            lv_obj_set_style_text_font(s_value, &lv_font_montserrat_28, LV_PART_MAIN);
            if (action) {
                // Everything lifts to clear the pill. The orb gives up the
                // most, since it is the element with the least to say on a
                // screen that is waiting for a decision.
                // 240 px, accounted for: orb 4..132, amount 134..171,
                // detail 172..190, pill 192..238. The orb sits high enough to
                // share the chrome row's band, which is safe because it is
                // horizontally clear of both the mode label and the pill.
                if (s_orb) lv_obj_align(s_orb, LV_ALIGN_TOP_MID, 0, 4);
                lv_obj_align(s_value,  LV_ALIGN_TOP_MID, 0, 134);
                lv_obj_align(s_detail, LV_ALIGN_TOP_MID, 0, 172);
            } else {
                if (s_orb) lv_obj_align(s_orb, LV_ALIGN_TOP_MID, 0, 28);
                lv_obj_align(s_value,  LV_ALIGN_TOP_MID, 0, 162);
                lv_obj_align(s_detail, LV_ALIGN_TOP_MID, 0, 198);
            }
        } else {
            lv_obj_set_style_text_font(s_value, &lv_font_montserrat_40, LV_PART_MAIN);
            lv_obj_align(s_kicker, LV_ALIGN_TOP_MID, 0, 48);
            lv_obj_align(s_value,  LV_ALIGN_TOP_MID, 0, 68);
            lv_obj_align(s_detail, LV_ALIGN_TOP_MID, 0, 118);
        }

        if (action) {
            lv_obj_align(s_action, LV_ALIGN_BOTTOM_MID, 0, -2);
            // The secondary key steps aside into the corner rather than
            // sitting under the pill, where there is no room for it.
            lv_obj_align(s_footer, LV_ALIGN_BOTTOM_RIGHT, -PAD_X, -12);
        } else {
            lv_obj_align(s_footer, LV_ALIGN_BOTTOM_MID, 0, -10);
        }

        s_last_moment = (int)moment;
        s_last_action = (int)action;
    }

    if (!moment && !action) {
        if (changed_u32(&s_c_card_bg, m->card_bg ? m->card_bg : UI_CARD)) {
            lv_obj_set_style_bg_color(s_card, lv_color_hex(s_c_card_bg), LV_PART_MAIN);
        }
        if (changed_u32(&s_c_card_border, m->card_border ? m->card_border : UI_HAIRLINE)) {
            lv_obj_set_style_border_color(s_card, lv_color_hex(s_c_card_border), LV_PART_MAIN);
        }
        if (changed_u32(&s_c_card_border_w, (uint32_t)(m->card_border_w ? m->card_border_w : 1))) {
            lv_obj_set_style_border_width(s_card, (int32_t)s_c_card_border_w, LV_PART_MAIN);
        }
        set_text(s_card_text, s_c_card, sizeof(s_c_card), m->card_text);
    }

    if (action) {
        set_text(s_action_text, s_c_action, sizeof(s_c_action), m->action);
        if (changed_u32(&s_c_action_col, m->action_color ? m->action_color : UI_PURPLE_SOFT)) {
            lv_obj_set_style_bg_color(s_action, lv_color_hex(s_c_action_col), LV_PART_MAIN);
        }
    }

    set_text(s_footer, s_c_footer, sizeof(s_c_footer), m->footer);

    bsp_display_unlock();
}

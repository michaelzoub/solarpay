#include "ui.h"

#include <string.h>

#include "bsp.h"
#include "lvgl.h"

static lv_obj_t *s_shell, *s_brand, *s_mode, *s_state, *s_kicker, *s_value,
                *s_detail, *s_card, *s_card_text, *s_footer;
static lv_obj_t *s_home_box, *s_home_sender, *s_home_merchant, *s_home_hint;

static lv_obj_t *label(lv_obj_t *parent, const lv_font_t *font, uint32_t color)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, LV_PART_MAIN);
    lv_obj_set_style_text_color(l, lv_color_hex(color), LV_PART_MAIN);
    lv_obj_set_style_text_align(l, LV_TEXT_ALIGN_CENTER, LV_PART_MAIN);
    return l;
}

void ui_init(void)
{
    bsp_display_lock(2000);

    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_hex(UI_INK), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_pad_all(scr, 0, LV_PART_MAIN);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    s_shell = lv_obj_create(scr);
    lv_obj_set_size(s_shell, BSP_LCD_H_RES, BSP_LCD_V_RES);
    lv_obj_center(s_shell);
    lv_obj_set_style_bg_color(s_shell, lv_color_hex(UI_INK), LV_PART_MAIN);
    lv_obj_set_style_border_width(s_shell, 0, LV_PART_MAIN);
    lv_obj_set_style_radius(s_shell, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_shell, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_shell, LV_OBJ_FLAG_SCROLLABLE);

    s_brand = label(s_shell, &lv_font_montserrat_22, UI_WHITE);
    lv_label_set_text(s_brand, "solarpay");
    lv_obj_align(s_brand, LV_ALIGN_TOP_MID, 0, 7);

    s_mode  = label(s_shell, &lv_font_montserrat_14, UI_DIM);
    lv_obj_align(s_mode, LV_ALIGN_TOP_LEFT, 12, 37);

    s_state = label(s_shell, &lv_font_montserrat_14, UI_PURPLE);
    lv_obj_align(s_state, LV_ALIGN_TOP_RIGHT, -12, 37);

    s_kicker = label(s_shell, &lv_font_montserrat_14, UI_YELLOW);
    s_value  = label(s_shell, &lv_font_montserrat_28, UI_WHITE);
    s_detail = label(s_shell, &lv_font_montserrat_14, UI_SOFT);

    s_card = lv_obj_create(s_shell);
    lv_obj_set_size(s_card, 296, 82);
    lv_obj_align(s_card, LV_ALIGN_BOTTOM_MID, 0, -26);
    lv_obj_set_style_radius(s_card, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_card, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_card, LV_OBJ_FLAG_SCROLLABLE);

    s_card_text = label(s_card, &lv_font_montserrat_14, UI_WHITE);
    lv_obj_center(s_card_text);

    s_footer = label(s_shell, &lv_font_montserrat_14, UI_DIM);
    lv_obj_align(s_footer, LV_ALIGN_BOTTOM_MID, 0, -5);

    // --- home screen widgets, hidden unless the home screen is showing ---
    s_home_box = lv_obj_create(s_shell);
    lv_obj_set_size(s_home_box, 296, 120);
    lv_obj_align(s_home_box, LV_ALIGN_CENTER, 0, 8);
    lv_obj_set_style_bg_opa(s_home_box, LV_OPA_TRANSP, LV_PART_MAIN);
    lv_obj_set_style_border_width(s_home_box, 0, LV_PART_MAIN);
    lv_obj_set_style_pad_all(s_home_box, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_home_box, LV_OBJ_FLAG_SCROLLABLE);

    s_home_sender = lv_obj_create(s_home_box);
    lv_obj_set_size(s_home_sender, 140, 84);
    lv_obj_align(s_home_sender, LV_ALIGN_LEFT_MID, 2, 0);
    lv_obj_set_style_radius(s_home_sender, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_home_sender, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_t *ls = label(s_home_sender, &lv_font_montserrat_16, UI_WHITE);
    lv_label_set_text(ls, "SENDER\n\nPAY");
    lv_obj_center(ls);

    s_home_merchant = lv_obj_create(s_home_box);
    lv_obj_set_size(s_home_merchant, 140, 84);
    lv_obj_align(s_home_merchant, LV_ALIGN_RIGHT_MID, -2, 0);
    lv_obj_set_style_radius(s_home_merchant, 0, LV_PART_MAIN);
    lv_obj_remove_flag(s_home_merchant, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_t *lm = label(s_home_merchant, &lv_font_montserrat_16, UI_WHITE);
    lv_label_set_text(lm, "MERCHANT\n\nCHARGE");
    lv_obj_center(lm);

    s_home_hint = label(s_shell, &lv_font_montserrat_14, UI_DIM);
    lv_obj_align(s_home_hint, LV_ALIGN_BOTTOM_MID, 0, -5);
    lv_label_set_text(s_home_hint, "LEFT / RIGHT SELECT      A START");

    bsp_display_unlock();
}

static void show(lv_obj_t *o, bool visible)
{
    if (visible) lv_obj_remove_flag(o, LV_OBJ_FLAG_HIDDEN);
    else         lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN);
}

void ui_render(const ui_model_t *m)
{
    if (!bsp_display_lock(60)) return;

    bool home = (m->screen == UI_SCREEN_HOME);

    show(s_home_box, home);
    show(s_home_hint, home);
    show(s_mode, !home);
    show(s_state, !home);
    show(s_kicker, !home);
    show(s_value, !home);
    show(s_detail, !home);
    show(s_card, !home);
    show(s_footer, !home);

    if (home) {
        bool sender = (m->home_selection == 0);
        lv_obj_set_style_bg_color(s_home_sender, lv_color_hex(sender ? UI_PANEL : UI_INK), LV_PART_MAIN);
        lv_obj_set_style_border_color(s_home_sender, lv_color_hex(sender ? UI_CYAN : UI_DIM), LV_PART_MAIN);
        lv_obj_set_style_border_width(s_home_sender, sender ? 3 : 1, LV_PART_MAIN);

        lv_obj_set_style_bg_color(s_home_merchant, lv_color_hex(!sender ? UI_PANEL : UI_INK), LV_PART_MAIN);
        lv_obj_set_style_border_color(s_home_merchant, lv_color_hex(!sender ? UI_GREEN : UI_DIM), LV_PART_MAIN);
        lv_obj_set_style_border_width(s_home_merchant, !sender ? 3 : 1, LV_PART_MAIN);

        bsp_display_unlock();
        return;
    }

    lv_label_set_text(s_mode, m->mode ? m->mode : "");
    lv_obj_set_style_text_color(s_mode, lv_color_hex(m->mode_color), LV_PART_MAIN);

    lv_label_set_text(s_state, m->state ? m->state : "");
    lv_obj_set_style_text_color(s_state, lv_color_hex(m->state_color), LV_PART_MAIN);

    lv_label_set_text(s_kicker, m->kicker ? m->kicker : "");
    lv_obj_set_style_text_color(s_kicker, lv_color_hex(m->kicker_color), LV_PART_MAIN);
    lv_label_set_text(s_value, m->value ? m->value : "");
    lv_label_set_text(s_detail, m->detail ? m->detail : "");

    // The Lua apps left-align the idle screens and centre the payment screens.
    if (m->center_block) {
        lv_obj_align(s_kicker, LV_ALIGN_TOP_MID, 0, 66);
        lv_obj_align(s_value,  LV_ALIGN_TOP_MID, 0, 89);
        lv_obj_align(s_detail, LV_ALIGN_TOP_MID, 0, 118);
    } else {
        lv_obj_align(s_kicker, LV_ALIGN_TOP_LEFT, 12, 66);
        lv_obj_align(s_value,  LV_ALIGN_TOP_LEFT, 12, 84);
        lv_obj_align(s_detail, LV_ALIGN_TOP_LEFT, 12, 116);
    }

    lv_obj_set_style_bg_color(s_card, lv_color_hex(m->card_bg), LV_PART_MAIN);
    lv_obj_set_style_border_color(s_card, lv_color_hex(m->card_border), LV_PART_MAIN);
    lv_obj_set_style_border_width(s_card, m->card_border_w, LV_PART_MAIN);
    lv_label_set_text(s_card_text, m->card_text ? m->card_text : "");

    lv_label_set_text(s_footer, m->footer ? m->footer : "");

    bsp_display_unlock();
}

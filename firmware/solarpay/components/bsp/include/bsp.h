// Board support for the Hack the North 2026 Hacker Badge (ESP32-C3-MINI-1-N4).
//
// Every pin and register value here comes from the official custom-flash guide
// (docs/vendor/custom-firmware-hal.md), not from probing.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

// ---------------------------------------------------------------------------
// Pin map (HAL guide section 02)
// ---------------------------------------------------------------------------
#define BSP_PIN_LCD_MOSI    10
#define BSP_PIN_LCD_CLK      1
#define BSP_PIN_LCD_CS       2
#define BSP_PIN_LCD_DC       0
#define BSP_PIN_LCD_RST      4

#define BSP_PIN_I2C_SDA      5
#define BSP_PIN_I2C_SCL      6

#define BSP_PIN_HC165_DATA   7
#define BSP_PIN_HC165_LOAD  20
#define BSP_PIN_HC165_CLK   21

#define BSP_PIN_START        9   // active-low; also the download-mode strapping pin
#define BSP_PIN_LED_DIN      3

#define BSP_LCD_H_RES      320
#define BSP_LCD_V_RES      240
#define BSP_LED_COUNT        6

#define BSP_I2C_ADDR_ACCEL 0x19
#define BSP_I2C_ADDR_NFC   0x26

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
// Shift order out of the 74HC165, active-low, A first (HAL guide section 03).
typedef enum {
    BSP_BTN_A = 0,
    BSP_BTN_B,
    BSP_BTN_HOME,
    BSP_BTN_DOWN,
    BSP_BTN_LEFT,
    BSP_BTN_RIGHT,
    BSP_BTN_UP,
    BSP_BTN_AUX1,     // maintained side switch, not momentary
    BSP_BTN_START,    // dedicated GPIO9 pushbutton
    BSP_BTN_COUNT,
} bsp_btn_t;

typedef enum {
    BSP_BTN_RELEASED = 0,
    BSP_BTN_PRESSED  = 1,
} bsp_btn_edge_t;

// Called from the input task on every debounced edge.
typedef void (*bsp_btn_cb_t)(bsp_btn_t btn, bsp_btn_edge_t edge, void *ctx);

esp_err_t bsp_input_init(void);
void      bsp_input_set_callback(bsp_btn_cb_t cb, void *ctx);
// Debounced level, true while held. AUX1 reads its maintained position.
bool      bsp_input_is_down(bsp_btn_t btn);
// Raw latched byte from the shift register, for bring-up logging only.
uint8_t   bsp_input_raw(void);

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
// Brings up SPI2 + ST7789 + LVGL and starts the tick/timer task. LVGL calls
// must be made under bsp_display_lock().
esp_err_t bsp_display_init(void);
bool      bsp_display_lock(uint32_t timeout_ms);
void      bsp_display_unlock(void);
// Bring-up aid: solid colour fill straight to the panel, before LVGL is used.
esp_err_t bsp_display_test_fill(uint16_t rgb565);

// ---------------------------------------------------------------------------
// LEDs (6x WS2812B-2020 on GPIO3, GRB order, RMT driven)
// ---------------------------------------------------------------------------
// Front order: 0 UpperLeft, 1 UpperRight, 2 MiddleRight,
//              3 BottomRight, 4 BottomLeft, 5 MiddleLeft.
esp_err_t bsp_led_init(void);
void      bsp_led_clear(void);
void      bsp_led_set(int index, uint8_t r, uint8_t g, uint8_t b);
void      bsp_led_set_all(uint8_t r, uint8_t g, uint8_t b);
void      bsp_led_show(void);

// ---------------------------------------------------------------------------
// Accelerometer (SC7A20, 0x19)
// ---------------------------------------------------------------------------
typedef struct {
    int16_t x_mg;
    int16_t y_mg;
    int16_t z_mg;
} bsp_accel_sample_t;

esp_err_t bsp_accel_init(void);
esp_err_t bsp_accel_read(bsp_accel_sample_t *out);
// Magnitude of the high-passed acceleration in mg, updated by bsp_accel_read.
uint16_t  bsp_accel_shock_mg(void);

#ifdef __cplusplus
}
#endif

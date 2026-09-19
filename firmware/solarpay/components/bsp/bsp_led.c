// 6x WS2812B-2020 on a single data line (GPIO3), GRB order, driven by RMT.
//
// The HAL guide warns that full white on all six can brown out the board on AA
// power, so every colour written here passes through a brightness ceiling.
#include "bsp.h"

#include "esp_log.h"
#include "led_strip.h"

static const char *TAG = "bsp_led";

// Ceiling per channel. The Lua apps drove these LEDs at up to 255; on battery
// that is enough to brown out the boost converter, so scale into a safe range.
// Measured concern, not theoretical: this firmware runs Wi-Fi, whose transmit
// bursts draw current the stock Lua firmware never did, on top of the LEDs the
// HAL guide already warns can brown out the board on AA power. Half the
// previous ceiling costs little visually and buys headroom for a radio burst
// landing on top of a full-brightness frame.
#define LED_MAX_LEVEL 48

static led_strip_handle_t s_strip;

static inline uint8_t clamp_level(uint8_t v)
{
    return (uint8_t)((uint32_t)v * LED_MAX_LEVEL / 255u);
}

esp_err_t bsp_led_init(void)
{
    led_strip_config_t strip_cfg = {
        .strip_gpio_num   = BSP_PIN_LED_DIN,
        .max_leds         = BSP_LED_COUNT,
        .led_model        = LED_MODEL_WS2812,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
        .flags.invert_out = false,
    };
    led_strip_rmt_config_t rmt_cfg = {
        .clk_src        = RMT_CLK_SRC_DEFAULT,
        .resolution_hz  = 10 * 1000 * 1000,
        .mem_block_symbols = 64,
        .flags.with_dma = false,
    };
    esp_err_t err = led_strip_new_rmt_device(&strip_cfg, &rmt_cfg, &s_strip);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "led_strip init failed: %s", esp_err_to_name(err));
        return err;
    }
    led_strip_clear(s_strip);
    ESP_LOGI(TAG, "6x WS2812B up on GPIO%d (ceiling %d/255)", BSP_PIN_LED_DIN, LED_MAX_LEVEL);
    return ESP_OK;
}

void bsp_led_clear(void)
{
    if (s_strip) {
        led_strip_clear(s_strip);
    }
}

void bsp_led_set(int index, uint8_t r, uint8_t g, uint8_t b)
{
    if (!s_strip || index < 0 || index >= BSP_LED_COUNT) {
        return;
    }
    led_strip_set_pixel(s_strip, (uint32_t)index,
                        clamp_level(r), clamp_level(g), clamp_level(b));
}

void bsp_led_set_all(uint8_t r, uint8_t g, uint8_t b)
{
    for (int i = 0; i < BSP_LED_COUNT; i++) {
        bsp_led_set(i, r, g, b);
    }
}

void bsp_led_show(void)
{
    if (s_strip) {
        led_strip_refresh(s_strip);
    }
}

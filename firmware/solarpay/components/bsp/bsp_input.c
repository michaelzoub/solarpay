// Buttons: 8 inputs on a 74HC165 shift register, plus Start on GPIO9.
//
// Read protocol (HAL guide section 03): pulse LOAD low then high to latch, then
// 8 times: sample DATA, pulse CLK high-low. A sampled 0 means pressed. The
// first bit out is A, then B, Home, Down, Left, Right, Up, Aux1.
#include "bsp.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "bsp_input";

// ~10 ms poll with 3 consecutive agreeing samples before an edge is reported.
#define POLL_PERIOD_MS   10
#define DEBOUNCE_SAMPLES  3
// 74HC165 is happy far faster than this; the delay just keeps edges clean.
#define CLK_DELAY_US      2

static bsp_btn_cb_t s_cb;
static void        *s_cb_ctx;
static bool         s_stable[BSP_BTN_COUNT];
static uint8_t      s_streak[BSP_BTN_COUNT];
static bool         s_candidate[BSP_BTN_COUNT];
static uint8_t      s_raw_latch;

// Latch the parallel inputs, then shift 8 bits out MSB-of-chain first.
static uint8_t hc165_read(void)
{
    gpio_set_level(BSP_PIN_HC165_LOAD, 0);
    esp_rom_delay_us(CLK_DELAY_US);
    gpio_set_level(BSP_PIN_HC165_LOAD, 1);
    esp_rom_delay_us(CLK_DELAY_US);

    uint8_t bits = 0;
    for (int i = 0; i < 8; i++) {
        // Sample before clocking: the first bit is already presented by the latch.
        if (gpio_get_level(BSP_PIN_HC165_DATA)) {
            bits |= (uint8_t)(1u << i);
        }
        gpio_set_level(BSP_PIN_HC165_CLK, 1);
        esp_rom_delay_us(CLK_DELAY_US);
        gpio_set_level(BSP_PIN_HC165_CLK, 0);
        esp_rom_delay_us(CLK_DELAY_US);
    }
    return bits;
}

static void input_task(void *arg)
{
    (void)arg;
    TickType_t last = xTaskGetTickCount();

    for (;;) {
        uint8_t raw = hc165_read();
        s_raw_latch = raw;

        bool now_down[BSP_BTN_COUNT];
        for (int i = 0; i < 8; i++) {
            // Active low: a 0 bit means the button is held.
            now_down[i] = ((raw >> i) & 1u) == 0u;
        }
        now_down[BSP_BTN_START] = gpio_get_level(BSP_PIN_START) == 0;

        for (int i = 0; i < BSP_BTN_COUNT; i++) {
            if (now_down[i] == s_stable[i]) {
                s_streak[i] = 0;
                continue;
            }
            if (now_down[i] != s_candidate[i]) {
                s_candidate[i] = now_down[i];
                s_streak[i] = 1;
                continue;
            }
            if (++s_streak[i] >= DEBOUNCE_SAMPLES) {
                s_stable[i] = now_down[i];
                s_streak[i] = 0;
                if (s_cb) {
                    s_cb((bsp_btn_t)i,
                         s_stable[i] ? BSP_BTN_PRESSED : BSP_BTN_RELEASED,
                         s_cb_ctx);
                }
            }
        }
        vTaskDelayUntil(&last, pdMS_TO_TICKS(POLL_PERIOD_MS));
    }
}

esp_err_t bsp_input_init(void)
{
    gpio_config_t out = {
        .pin_bit_mask = (1ULL << BSP_PIN_HC165_LOAD) | (1ULL << BSP_PIN_HC165_CLK),
        .mode         = GPIO_MODE_OUTPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&out));

    gpio_config_t in = {
        .pin_bit_mask = (1ULL << BSP_PIN_HC165_DATA),
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&in));

    // Start is an active-low pushbutton to ground; it needs the internal pull-up.
    gpio_config_t start = {
        .pin_bit_mask = (1ULL << BSP_PIN_START),
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&start));

    gpio_set_level(BSP_PIN_HC165_LOAD, 1);
    gpio_set_level(BSP_PIN_HC165_CLK, 0);

    BaseType_t ok = xTaskCreate(input_task, "bsp_input", 2560, NULL, 6, NULL);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "input task create failed");
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "buttons up: HC165 data=%d load=%d clk=%d, start=%d",
             BSP_PIN_HC165_DATA, BSP_PIN_HC165_LOAD, BSP_PIN_HC165_CLK, BSP_PIN_START);
    return ESP_OK;
}

void bsp_input_set_callback(bsp_btn_cb_t cb, void *ctx)
{
    s_cb_ctx = ctx;
    s_cb = cb;
}

bool bsp_input_is_down(bsp_btn_t btn)
{
    return (btn < BSP_BTN_COUNT) ? s_stable[btn] : false;
}

uint8_t bsp_input_raw(void)
{
    return s_raw_latch;
}

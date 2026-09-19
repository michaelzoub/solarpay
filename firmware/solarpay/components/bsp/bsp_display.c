// ST7789 320x240 RGB565 over SPI2, with LVGL on top.
//
// Panel orientation follows the HAL guide exactly: invert_color(true),
// swap_xy(true), mirror(true, false). Those three calls are what make the
// image land the right way up on this board.
#include "bsp.h"

#include <string.h>

#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"

static const char *TAG = "bsp_display";

#define LCD_SPI_HOST      SPI2_HOST
#define LCD_PIXEL_CLK_HZ  (40 * 1000 * 1000)
#define LCD_CMD_BITS      8
#define LCD_PARAM_BITS    8
// Two stripe buffers of 30 rows each, as the HAL guide recommends.
#define LCD_STRIPE_ROWS   30
#define LVGL_TICK_MS      2
#define LVGL_TASK_STACK   6144

static esp_lcd_panel_handle_t    s_panel;
static esp_lcd_panel_io_handle_t s_io;
static lv_display_t             *s_disp;
static SemaphoreHandle_t         s_lock;

// Called by esp_lcd when a colour transfer finishes; releases LVGL's flush.
static bool on_color_done(esp_lcd_panel_io_handle_t io,
                          esp_lcd_panel_io_event_data_t *data,
                          void *ctx)
{
    (void)io; (void)data;
    lv_display_flush_ready((lv_display_t *)ctx);
    return false;
}

static void lvgl_flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px)
{
    // LVGL hands us native-endian RGB565; the panel wants big-endian on the wire.
    lv_draw_sw_rgb565_swap(px, lv_area_get_size(area));
    esp_lcd_panel_draw_bitmap(s_panel,
                              area->x1, area->y1,
                              area->x2 + 1, area->y2 + 1,
                              px);
    (void)disp;
}

static void lvgl_tick_cb(void *arg)
{
    (void)arg;
    lv_tick_inc(LVGL_TICK_MS);
}

static void lvgl_task(void *arg)
{
    (void)arg;
    for (;;) {
        uint32_t wait_ms = 10;
        if (bsp_display_lock(50)) {
            wait_ms = lv_timer_handler();
            bsp_display_unlock();
        }
        if (wait_ms > 100) wait_ms = 100;
        if (wait_ms < 4)   wait_ms = 4;
        vTaskDelay(pdMS_TO_TICKS(wait_ms));
    }
}

esp_err_t bsp_display_init(void)
{
    esp_err_t err;

    spi_bus_config_t bus = {
        .mosi_io_num     = BSP_PIN_LCD_MOSI,
        .miso_io_num     = -1,
        .sclk_io_num     = BSP_PIN_LCD_CLK,
        .quadwp_io_num   = -1,
        .quadhd_io_num   = -1,
        .max_transfer_sz = BSP_LCD_H_RES * LCD_STRIPE_ROWS * sizeof(uint16_t),
    };
    err = spi_bus_initialize(LCD_SPI_HOST, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi bus init failed: %s", esp_err_to_name(err));
        return err;
    }

    esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num       = BSP_PIN_LCD_DC,
        .cs_gpio_num       = BSP_PIN_LCD_CS,
        .pclk_hz           = LCD_PIXEL_CLK_HZ,
        .lcd_cmd_bits      = LCD_CMD_BITS,
        .lcd_param_bits    = LCD_PARAM_BITS,
        .spi_mode          = 0,
        .trans_queue_depth = 10,
    };
    err = esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_SPI_HOST, &io_cfg, &s_io);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "panel io failed: %s", esp_err_to_name(err));
        return err;
    }

    esp_lcd_panel_dev_config_t panel_cfg = {
        .reset_gpio_num = BSP_PIN_LCD_RST,
        .rgb_ele_order  = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
    };
    err = esp_lcd_new_panel_st7789(s_io, &panel_cfg, &s_panel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "st7789 init failed: %s", esp_err_to_name(err));
        return err;
    }

    ESP_ERROR_CHECK(esp_lcd_panel_reset(s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(s_panel));
    // The three orientation calls the badge needs, per the HAL guide.
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(s_panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_swap_xy(s_panel, true));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(s_panel, true, false));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, true));

    ESP_LOGI(TAG, "ST7789 up: %dx%d, SPI2 @ %d MHz",
             BSP_LCD_H_RES, BSP_LCD_V_RES, LCD_PIXEL_CLK_HZ / 1000000);

    s_lock = xSemaphoreCreateRecursiveMutex();
    if (!s_lock) {
        return ESP_ERR_NO_MEM;
    }

    lv_init();

    s_disp = lv_display_create(BSP_LCD_H_RES, BSP_LCD_V_RES);
    if (!s_disp) {
        return ESP_ERR_NO_MEM;
    }

    size_t buf_bytes = BSP_LCD_H_RES * LCD_STRIPE_ROWS * sizeof(uint16_t);
    void *buf1 = heap_caps_malloc(buf_bytes, MALLOC_CAP_DMA);
    void *buf2 = heap_caps_malloc(buf_bytes, MALLOC_CAP_DMA);
    if (!buf1 || !buf2) {
        ESP_LOGE(TAG, "no DMA memory for %u byte stripe buffers", (unsigned)buf_bytes);
        free(buf1);
        free(buf2);
        return ESP_ERR_NO_MEM;
    }

    lv_display_set_color_format(s_disp, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(s_disp, buf1, buf2, buf_bytes, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(s_disp, lvgl_flush_cb);

    const esp_lcd_panel_io_callbacks_t cbs = { .on_color_trans_done = on_color_done };
    ESP_ERROR_CHECK(esp_lcd_panel_io_register_event_callbacks(s_io, &cbs, s_disp));

    const esp_timer_create_args_t tick = {
        .callback = lvgl_tick_cb,
        .name     = "lvgl_tick",
    };
    esp_timer_handle_t tick_timer;
    ESP_ERROR_CHECK(esp_timer_create(&tick, &tick_timer));
    ESP_ERROR_CHECK(esp_timer_start_periodic(tick_timer, LVGL_TICK_MS * 1000));

    if (xTaskCreate(lvgl_task, "lvgl", LVGL_TASK_STACK, NULL, 4, NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    ESP_LOGI(TAG, "LVGL up with 2x %u byte DMA stripe buffers", (unsigned)buf_bytes);
    return ESP_OK;
}

bool bsp_display_lock(uint32_t timeout_ms)
{
    if (!s_lock) {
        return false;
    }
    TickType_t ticks = (timeout_ms == UINT32_MAX) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    return xSemaphoreTakeRecursive(s_lock, ticks) == pdTRUE;
}

void bsp_display_unlock(void)
{
    if (s_lock) {
        xSemaphoreGiveRecursive(s_lock);
    }
}

esp_err_t bsp_display_test_fill(uint16_t rgb565)
{
    if (!s_panel) {
        return ESP_ERR_INVALID_STATE;
    }
    size_t row_px = BSP_LCD_H_RES;
    uint16_t *row = heap_caps_malloc(row_px * sizeof(uint16_t), MALLOC_CAP_DMA);
    if (!row) {
        return ESP_ERR_NO_MEM;
    }
    uint16_t be = (uint16_t)((rgb565 >> 8) | (rgb565 << 8));
    for (size_t i = 0; i < row_px; i++) {
        row[i] = be;
    }
    for (int y = 0; y < BSP_LCD_V_RES; y++) {
        esp_lcd_panel_draw_bitmap(s_panel, 0, y, BSP_LCD_H_RES, y + 1, row);
    }
    vTaskDelay(pdMS_TO_TICKS(50));
    free(row);
    return ESP_OK;
}

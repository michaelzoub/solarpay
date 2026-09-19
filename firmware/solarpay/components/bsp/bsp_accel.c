// SC7A20 accelerometer at 0x19 on the I2C bus it shares with the MFRC522 NFC
// reader. Every transfer is bounded: the HAL guide is explicit that this bus
// must never be waited on forever.
#include "bsp.h"

#include <stdlib.h>
#include <string.h>

#include "driver/i2c_master.h"
#include "esp_log.h"

static const char *TAG = "bsp_accel";

#define REG_WHO_AM_I   0x0F
#define REG_CTRL_REG1  0x20
#define REG_CTRL_REG4  0x23
#define REG_STATUS     0x27
#define REG_OUT_X_L    0x28
#define WHO_AM_I_VALUE 0x11
// Auto-increment bit for multi-byte reads.
#define AUTO_INC       0x80

#define I2C_TIMEOUT_MS 50

// mg per LSB at the +/- 8 g full-scale range selected in CTRL_REG4.
#define ACCEL_MG_PER_COUNT 4

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_accel;

// Single-pole high-pass: tracks gravity so shock_mg reports only the transient.
static int32_t  s_bias_x, s_bias_y, s_bias_z;
static bool     s_bias_primed;
static uint16_t s_shock_mg;

static esp_err_t reg_write(uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = { reg, val };
    return i2c_master_transmit(s_accel, buf, sizeof(buf), I2C_TIMEOUT_MS);
}

static esp_err_t reg_read(uint8_t reg, uint8_t *dst, size_t len)
{
    return i2c_master_transmit_receive(s_accel, &reg, 1, dst, len, I2C_TIMEOUT_MS);
}

esp_err_t bsp_accel_init(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port          = I2C_NUM_0,
        .sda_io_num        = BSP_PIN_I2C_SDA,
        .scl_io_num        = BSP_PIN_I2C_SCL,
        .clk_source        = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bus_cfg, &s_bus);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c bus init failed: %s", esp_err_to_name(err));
        return err;
    }

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address  = BSP_I2C_ADDR_ACCEL,
        .scl_speed_hz    = 400 * 1000,
    };
    err = i2c_master_bus_add_device(s_bus, &dev_cfg, &s_accel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c add device failed: %s", esp_err_to_name(err));
        return err;
    }

    uint8_t who = 0;
    err = reg_read(REG_WHO_AM_I, &who, 1);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "WHO_AM_I read failed: %s", esp_err_to_name(err));
        return err;
    }
    if (who != WHO_AM_I_VALUE) {
        ESP_LOGE(TAG, "WHO_AM_I = 0x%02x, expected 0x%02x", who, WHO_AM_I_VALUE);
        return ESP_ERR_NOT_FOUND;
    }

    // 100 Hz, all three axes enabled.
    err = reg_write(REG_CTRL_REG1, 0x57);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "CTRL_REG1 write failed: %s", esp_err_to_name(err));
        return err;
    }
    // +/- 8 g, block data update.
    //
    // The HAL guide suggests +/- 2 g (CTRL_REG4 = 0x80). Measured on hardware,
    // a deliberate badge-to-badge knock peaks at 1900-2700 mg and CLIPS against
    // the +/- 2 g rail (raw axes pinned at +/-2047). Clipping is fatal to the
    // tap design specifically: two badges compare impact magnitudes to decide
    // they felt the *same* knock, and saturated readings all look alike. At
    // +/- 8 g a hard knock lands around a third of full scale with room to spare.
    err = reg_write(REG_CTRL_REG4, 0xA0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "CTRL_REG4 write failed: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "SC7A20 up at 0x%02x, WHO_AM_I 0x%02x, 100 Hz +/-8g",
             BSP_I2C_ADDR_ACCEL, who);
    return ESP_OK;
}

esp_err_t bsp_accel_read(bsp_accel_sample_t *out)
{
    if (!out || !s_accel) {
        return ESP_ERR_INVALID_STATE;
    }
    uint8_t raw[6];
    esp_err_t err = reg_read(REG_OUT_X_L | AUTO_INC, raw, sizeof(raw));
    if (err != ESP_OK) {
        return err;
    }

    // Each axis is 12-bit left-justified. At +/- 8 g one count is 4 mg, so the
    // >> 4 that de-justifies the sample is followed by a x4 to land back in mg
    // and keep every threshold in this firmware expressed in real units.
    int16_t x = (int16_t)(((int16_t)((raw[1] << 8) | raw[0]) >> 4) * ACCEL_MG_PER_COUNT);
    int16_t y = (int16_t)(((int16_t)((raw[3] << 8) | raw[2]) >> 4) * ACCEL_MG_PER_COUNT);
    int16_t z = (int16_t)(((int16_t)((raw[5] << 8) | raw[4]) >> 4) * ACCEL_MG_PER_COUNT);

    out->x_mg = x;
    out->y_mg = y;
    out->z_mg = z;

    if (!s_bias_primed) {
        s_bias_x = x; s_bias_y = y; s_bias_z = z;
        s_bias_primed = true;
        s_shock_mg = 0;
        return ESP_OK;
    }

    // Leak the bias toward the current reading so orientation changes fade out
    // within a few hundred ms while a knock still shows up as a spike.
    s_bias_x += (x - s_bias_x) / 8;
    s_bias_y += (y - s_bias_y) / 8;
    s_bias_z += (z - s_bias_z) / 8;

    int32_t dx = x - s_bias_x, dy = y - s_bias_y, dz = z - s_bias_z;
    uint32_t mag2 = (uint32_t)(dx * dx + dy * dy + dz * dz);

    // Integer sqrt; magnitudes of interest are well under 8000 mg.
    uint32_t r = 0, bit = 1u << 30;
    while (bit > mag2) bit >>= 2;
    while (bit) {
        if (mag2 >= r + bit) { mag2 -= r + bit; r = (r >> 1) + bit; }
        else                 { r >>= 1; }
        bit >>= 2;
    }
    s_shock_mg = (r > UINT16_MAX) ? UINT16_MAX : (uint16_t)r;
    return ESP_OK;
}

uint16_t bsp_accel_shock_mg(void)
{
    return s_shock_mg;
}

idf_component_register(
    SRCS "bsp_display.c" "bsp_input.c" "bsp_led.c" "bsp_accel.c"
    INCLUDE_DIRS "include"
    REQUIRES driver esp_lcd esp_timer esp_driver_spi esp_driver_i2c esp_driver_gpio
    PRIV_REQUIRES led_strip lvgl
)

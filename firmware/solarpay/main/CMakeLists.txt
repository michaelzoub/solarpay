idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES bsp lvgl splink ui spconsole
    PRIV_REQUIRES spi_flash esp_hw_support
)

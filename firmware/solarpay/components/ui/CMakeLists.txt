idf_component_register(
    SRCS "ui.c" "orb.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "."
    REQUIRES bsp lvgl
    PRIV_REQUIRES esp_timer esp_hw_support
)

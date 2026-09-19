idf_component_register(
    SRCS "splink.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_event esp_netif
    PRIV_REQUIRES mbedtls nvs_flash esp_timer
)

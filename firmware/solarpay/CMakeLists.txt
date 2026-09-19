# SolarPay native firmware for the Hack the North 2026 Hacker Badge.
# Target: ESP32-C3-MINI-1-N4. Toolchain: ESP-IDF v5.5.3 (the badge's pinned version).
cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(solarpay)

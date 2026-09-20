// The orb: the badge-to-badge moment, drawn by hand.
//
// Why an island and not the whole screen. The panel is 320x240 RGB565 on SPI
// at 40 MHz, so a full frame is 153,600 B == 30.7 ms of pure DMA -- a ~32 fps
// ceiling before a single pixel is computed, on a single-core C3 that is also
// running Wi-Fi and ESP-NOW. A 128x128 island is 32,768 B == 6.5 ms, which
// leaves the best part of 25 ms per frame at 30 fps for the metaball field,
// the ripples and the particles. Smoothness was the stated priority, so the
// area is what gives.
//
// Nothing here is an LVGL widget. orb_attach() hands LVGL a canvas to composite
// and then this file owns those pixels outright.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "lvgl.h"
#include "ui.h"

#define ORB_W 128
#define ORB_H 128

// Creates the canvas under `parent` and starts the 30 fps timer. Returns the
// canvas object, or NULL if the 32 KB buffer could not be allocated -- callers
// must cope, the rest of the UI works without it.
lv_obj_t *orb_attach(lv_obj_t *parent);

// State the truth; the orb eases itself there. Cheap to call every repaint.
// `proximity` is 0 (far) .. 255 (touching) and is only read in UI_ORB_NEAR.
void orb_set(ui_orb_state_t state, uint8_t proximity);

// Frugal mode -- for running on battery.
//
// The orb is the badge's largest continuous load: the inner loop is 16,384
// pixels unconditionally, every frame, and each frame also hands LVGL 32 KB to
// push over SPI. At 30 fps that is a standing cost the rail pays forever, and
// it is at its worst in UI_ORB_NEAR, which is exactly the state a sender enters
// the instant a merchant arms and starts beaconing. Measured on this hardware
// the sender browns out at that transition on battery and not on USB.
//
// Frugal mode halves the frame rate and holds the NEAR ripple to its SEEKING
// amplitude, which together roughly halve both the pixel math and the display
// DMA. The shape, the colour and the proximity response are unchanged, so the
// orb still reads as the same object -- it simply breathes at 15 fps.
void orb_set_frugal(bool frugal);

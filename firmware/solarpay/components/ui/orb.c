// The orb -- metaballs, ripples and particles straight into an RGB565 canvas.
//
// Everything animated is eased rather than set: each frame the current value
// moves a fixed fraction of the way to its target, which makes a state change
// a ~180 ms settle with no keyframes to keep in sync (k=0.18 at 30 fps is a
// 185 ms time constant; the merge uses k=0.45 so pairing lands in ~75 ms and
// feels like a snap rather than a drift).
#include "orb.h"

#include <math.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"

static const char *TAG = "orb";

#define FRAME_MS   33
// On battery. Half the rate halves both the pixel math and the 32 KB of SPI
// DMA per frame; 15 fps still reads as motion on a breathing shape whose
// slowest ease is a 350 ms settle.
#define FRAME_MS_FRUGAL 66
#define CX         (ORB_W / 2)
#define CY         (ORB_H / 2)
#define FX         8              // 8.8 fixed point throughout
#define ONE        (1 << FX)

// Metaball falloff lookup, indexed by squared distance >> LUT_SHIFT. Rebuilt
// every frame because the radius is itself animated; 512 divides per frame is
// nothing next to 16,384 pixels, and it keeps the inner loop divide-free.
#define LUT_N      512
#define LUT_SHIFT  4

#define F_LO       120            // field value where the edge starts
#define F_HI       280            // ...and where it is fully opaque

#define NPART      28

typedef struct {
    int32_t x, y, vx, vy;         // 8.8 fixed
    uint8_t life, max_life;
} part_t;

static lv_obj_t   *s_canvas;
static uint16_t   *s_buf;
static lv_timer_t *s_timer;
static bool        s_frugal;

static ui_orb_state_t s_state = UI_ORB_OFF;
static uint8_t        s_prox;
static int64_t        s_state_ms;

// Eased state, all 8.8 fixed.
static int32_t e_sep, e_radius, e_ring, e_r, e_g, e_b;
static uint32_t s_phase;

static uint16_t s_lut[LUT_N];
static int16_t  s_sin[64];
static part_t   s_part[NPART];
static bool     s_particles_live;

// ---------------------------------------------------------------------------
static inline uint16_t rgb565(uint32_t r, uint32_t g, uint32_t b)
{
    return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}

// t = 0 gives a, t = 255 gives b.
static inline uint32_t mix8(uint32_t a, uint32_t b, uint32_t t)
{
    return a + (((int32_t)b - (int32_t)a) * (int32_t)t >> 8);
}

static inline int32_t ease(int32_t cur, int32_t target, int32_t k)
{
    return cur + (((target - cur) * k) >> 8);
}

static inline int32_t sin8(uint32_t phase)   // phase in 1/64 turns
{
    return s_sin[phase & 63];
}

// ---------------------------------------------------------------------------
// Targets for the current state. Pure function of (state, proximity).
// ---------------------------------------------------------------------------
static void targets(int32_t *sep, int32_t *radius, int32_t *ring,
                    uint32_t *accent, int32_t *k)
{
    *k = 46;                                  // ~185 ms settle

    switch (s_state) {
    case UI_ORB_CALM:
        // The screensaver. One lazy blob that breathes; nothing to decode.
        *sep    = 6 * ONE;
        *radius = (26 * ONE) + sin8(s_phase >> 3) * 10;
        *ring   = 0;
        *accent = UI_SKY;
        *k      = 24;                         // ~350 ms, deliberately languid
        break;

    case UI_ORB_SEEKING:
        // Armed, nobody found. A searching pulse with faint ripples going out.
        *sep    = 4 * ONE;
        *radius = (24 * ONE) + sin8(s_phase >> 2) * 14;
        *ring   = 110 * ONE;
        *accent = UI_SKY;
        break;

    case UI_ORB_NEAR: {
        // The centrepiece. Closer means bigger, tighter, louder and greener.
        int32_t p = (int32_t)s_prox;
        *sep    = (44 - (34 * p) / 255) * ONE;
        // Breathe, don't throb: the amplitude no longer grows with proximity
        // (it reached +/-14 px up close, which strobed), and the phase advances
        // half as fast so the motion reads as a slow swell.
        *radius = ((21 + (11 * p) / 255) * ONE) + sin8(s_phase >> 2) * 5;
        // The ripple is the one part of NEAR that grows without bound with
        // proximity, and it is pure extra work in the inner loop. On battery
        // hold it at the SEEKING amplitude: the blob still swells and greens
        // with proximity, which is what actually communicates closeness.
        *ring   = s_frugal ? (110 * ONE) : ((90 + p) * ONE);
        *accent = (mix8((UI_SKY >> 16) & 0xFF, (UI_MINT >> 16) & 0xFF, (uint32_t)p) << 16)
                | (mix8((UI_SKY >> 8)  & 0xFF, (UI_MINT >> 8)  & 0xFF, (uint32_t)p) << 8)
                |  mix8( UI_SKY        & 0xFF,  UI_MINT        & 0xFF, (uint32_t)p);
        break;
    }

    case UI_ORB_MERGED:
        // Snap. The two shapes become one and stay there.
        *sep    = 0;
        *radius = (33 * ONE) + sin8(s_phase >> 3) * 6;
        *ring   = 40 * ONE;
        *accent = UI_MINT;
        *k      = 115;                        // ~75 ms
        break;

    case UI_ORB_SUCCESS:
        *sep    = 0;
        *radius = (42 * ONE) + sin8(s_phase >> 2) * 8;
        *ring   = 220 * ONE;
        *accent = UI_MINT;
        *k      = 80;
        break;

    case UI_ORB_CONFIRMED:
        // The one state that stops moving. SUCCESS breathes and ripples, which
        // is right for "something just happened" and wrong for "this is
        // settled": a shape still in motion reads as a process still running.
        // So the radius is a constant with no sin8 term and the ripples decay
        // to nothing, leaving a still blob for the checkmark to be drawn on.
        *sep    = 0;
        *radius = 38 * ONE;
        *ring   = 0;
        *accent = UI_MINT;
        *k      = 60;
        break;

    case UI_ORB_FAILURE:
        // One slow collapse. No shake, no system-red.
        *sep    = 0;
        *radius = 15 * ONE;
        *ring   = 0;
        *accent = UI_CORAL;
        *k      = 30;
        break;

    default:
        *sep = 0; *radius = 0; *ring = 0; *accent = UI_PAPER;
        break;
    }
}

// ---------------------------------------------------------------------------
static void seed_particles(void)
{
    for (int i = 0; i < NPART; i++) {
        uint32_t r = esp_random();
        int32_t ang = (int32_t)(r & 63);
        int32_t spd = 120 + (int32_t)((r >> 6) & 255);
        s_part[i].x  = CX * ONE;
        s_part[i].y  = CY * ONE;
        s_part[i].vx = (sin8(ang + 16) * spd) >> 8;
        s_part[i].vy = (sin8(ang) * spd) >> 8;
        s_part[i].max_life = 20 + (uint8_t)((r >> 14) & 15);
        s_part[i].life = s_part[i].max_life;
    }
    s_particles_live = true;
}

static void step_particles(void)
{
    bool any = false;
    for (int i = 0; i < NPART; i++) {
        if (!s_part[i].life) continue;
        s_part[i].x += s_part[i].vx;
        s_part[i].y += s_part[i].vy;
        s_part[i].vy += 26;                   // a little gravity, it reads as joy
        s_part[i].vx -= s_part[i].vx >> 5;    // and a little drag
        s_part[i].vy -= s_part[i].vy >> 5;
        s_part[i].life--;
        any = true;
    }
    s_particles_live = any;
}

static void draw_particles(uint32_t accent)
{
    for (int i = 0; i < NPART; i++) {
        if (!s_part[i].life) continue;
        int px = s_part[i].x >> FX;
        int py = s_part[i].y >> FX;
        if (px < 0 || py < 0 || px >= ORB_W - 1 || py >= ORB_H - 1) continue;

        uint32_t a = (uint32_t)s_part[i].life * 255u / s_part[i].max_life;
        uint32_t r = mix8(UI_PAPER >> 16 & 0xFF, accent >> 16 & 0xFF, a);
        uint32_t g = mix8(UI_PAPER >> 8  & 0xFF, accent >> 8  & 0xFF, a);
        uint32_t b = mix8(UI_PAPER       & 0xFF, accent       & 0xFF, a);
        uint16_t c = rgb565(r, g, b);

        s_buf[py * ORB_W + px]           = c;
        s_buf[py * ORB_W + px + 1]       = c;
        s_buf[(py + 1) * ORB_W + px]     = c;
        s_buf[(py + 1) * ORB_W + px + 1] = c;
    }
}

// ---------------------------------------------------------------------------
// The checkmark.
//
// Drawn as an overlay after the field, the same way the particles are, rather
// than as an LVGL symbol on top of the canvas: it has to sit *inside* the blob
// and share its pixels, and nothing else in this UI is an icon font.
//
// The stroke reveals itself along its own arc length, so it is drawn the way a
// hand would draw it -- short segment down-right, long segment up-right -- and
// not faded in as a finished shape.
#define CHECK_DELAY_MS 120       // let the bloom settle before the mark starts
#define CHECK_DRAW_MS  400       // and how long the stroke takes to complete
#define CHECK_R        3         // half-width of the stroke, in pixels

// Endpoints relative to the centre, in whole pixels.
static const int8_t s_check[3][2] = { { -16, 2 }, { -5, 13 }, { 18, -12 } };

static void plot_disc(int32_t cx, int32_t cy, int32_t r, uint32_t color)
{
    const uint32_t cr = (color >> 16) & 0xFF, cg = (color >> 8) & 0xFF, cb = color & 0xFF;
    int32_t r2 = r * r, rin2 = (r - 1) * (r - 1);

    for (int32_t dy = -r; dy <= r; dy++) {
        int32_t y = cy + dy;
        if (y < 0 || y >= ORB_H) continue;
        for (int32_t dx = -r; dx <= r; dx++) {
            int32_t x = cx + dx;
            if (x < 0 || x >= ORB_W) continue;
            int32_t d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;

            uint16_t *px = &s_buf[y * ORB_W + x];
            if (d2 <= rin2) {
                *px = rgb565(cr, cg, cb);
            } else {
                // One blended rim pixel, so the stroke does not read as a
                // staircase at this size. Unpacking the RGB565 underneath is
                // cheaper than keeping a second buffer around for the mark.
                uint32_t u = *px;
                uint32_t ur = ((u >> 8) & 0xF8), ug = ((u >> 3) & 0xFC), ub = ((u << 3) & 0xF8);
                *px = rgb565(mix8(ur, cr, 128), mix8(ug, cg, 128), mix8(ub, cb, 128));
            }
        }
    }
}

static void draw_check(void)
{
    int64_t e = (esp_timer_get_time() / 1000) - s_state_ms - CHECK_DELAY_MS;
    if (e <= 0) return;

    uint32_t p = (e >= CHECK_DRAW_MS) ? 255u : (uint32_t)(e * 255 / CHECK_DRAW_MS);

    // Segment lengths, so the reveal runs at a constant speed along the path
    // rather than spending half the time on each segment -- the short leg
    // would otherwise crawl and the long leg would snap.
    int32_t l1 = 0, l2 = 0;
    for (int i = 0; i < 2; i++) {
        int32_t dx = s_check[i + 1][0] - s_check[i][0];
        int32_t dy = s_check[i + 1][1] - s_check[i][1];
        int32_t len = (int32_t)(sqrtf((float)(dx * dx + dy * dy)) + 0.5f);
        if (i == 0) l1 = len; else l2 = len;
    }

    int32_t total = l1 + l2;
    int32_t drawn = (int32_t)((uint32_t)total * p / 255u);

    for (int32_t s = 0; s <= drawn; s++) {
        int32_t seg = (s <= l1) ? 0 : 1;
        int32_t along = (seg == 0) ? s : (s - l1);
        int32_t len   = (seg == 0) ? l1 : l2;
        if (len <= 0) continue;

        int32_t x0 = s_check[seg][0],     y0 = s_check[seg][1];
        int32_t x1 = s_check[seg + 1][0], y1 = s_check[seg + 1][1];
        int32_t x = x0 + (x1 - x0) * along / len;
        int32_t y = y0 + (y1 - y0) * along / len;
        plot_disc(CX + x, CY + y, CHECK_R, UI_MINT_DEEP);
    }
}

// ---------------------------------------------------------------------------
static void render(void)
{
    int32_t t_sep, t_rad, t_ring, t_k;
    uint32_t t_accent;
    targets(&t_sep, &t_rad, &t_ring, &t_accent, &t_k);

    e_sep    = ease(e_sep,    t_sep,    t_k);
    e_radius = ease(e_radius, t_rad,    t_k);
    e_ring   = ease(e_ring,   t_ring,   t_k);
    e_r      = ease(e_r, (int32_t)((t_accent >> 16) & 0xFF) << FX, t_k);
    e_g      = ease(e_g, (int32_t)((t_accent >> 8)  & 0xFF) << FX, t_k);
    e_b      = ease(e_b, (int32_t)( t_accent        & 0xFF) << FX, t_k);

    uint32_t accent = ((uint32_t)(e_r >> FX) << 16)
                    | ((uint32_t)(e_g >> FX) << 8)
                    |  (uint32_t)(e_b >> FX);

    const uint32_t pr = (UI_PAPER >> 16) & 0xFF;
    const uint32_t pg = (UI_PAPER >> 8)  & 0xFF;
    const uint32_t pb =  UI_PAPER        & 0xFF;
    const uint32_t ar = (accent >> 16) & 0xFF;
    const uint32_t ag = (accent >> 8)  & 0xFF;
    const uint32_t ab =  accent        & 0xFF;
    const uint16_t paper16 = rgb565(pr, pg, pb);

    int32_t R = e_radius >> FX;
    if (R < 2) R = 2;
    int32_t R2 = R * R;

    for (int i = 0; i < LUT_N; i++) {
        int32_t d2 = i << LUT_SHIFT;
        s_lut[i] = (uint16_t)(((uint32_t)R2 << 8) / (uint32_t)(d2 + R2 / 4 + 1));
    }

    // The two sources drift on separate phases so the shape never looks hinged.
    int32_t sep = e_sep >> FX;
    int32_t ax = CX - sep / 2 + ((sin8(s_phase >> 3) * 5) >> 8);
    int32_t ay = CY + ((sin8((s_phase >> 3) + 11) * 6) >> 8);
    int32_t bx = CX + sep / 2 + ((sin8((s_phase >> 3) + 27) * 5) >> 8);
    int32_t by = CY + ((sin8((s_phase >> 3) + 40) * 6) >> 8);

    // Two ripples, expanding and fading. Tested against squared distance so
    // the inner loop never needs a square root.
    int32_t ring_amt = e_ring >> FX;
    uint32_t ring_in[2] = {0}, ring_out[2] = {0};
    uint32_t ring_a[2] = {0};
    if (ring_amt > 4) {
        for (int k = 0; k < 2; k++) {
            uint32_t ph = (s_phase + (uint32_t)k * 32) & 63;
            int32_t rr = (int32_t)(R + 6 + (ph * 52) / 64);
            int32_t rw = 2;
            ring_in[k]  = (uint32_t)((rr - rw) * (rr - rw));
            ring_out[k] = (uint32_t)((rr + rw) * (rr + rw));
            // A ripple must fade IN as it is born and OUT as it expands. The
            // first version was brightest at birth, so each time ph wrapped
            // 63 -> 0 a ring snapped back to full strength against the blob's
            // edge -- a hard pop twice every two seconds, and worse the closer
            // the peer got, because ring_amt scales with proximity. That read
            // as flicker, not as life.
            uint32_t env = (ph < 12) ? (ph * 255u / 12u)
                                     : ((63u - ph) * 255u / 51u);
            ring_a[k] = (env * (uint32_t)ring_amt) / 255u;
            if (ring_a[k] > 110) ring_a[k] = 110;
        }
    }

    for (int y = 0; y < ORB_H; y++) {
        int32_t dya = y - ay, dyb = y - by, dyc = y - CY;
        int32_t dya2 = dya * dya, dyb2 = dyb * dyb, dyc2 = dyc * dyc;
        uint16_t *row = s_buf + y * ORB_W;

        for (int x = 0; x < ORB_W; x++) {
            int32_t dxa = x - ax, dxb = x - bx;
            uint32_t ia = (uint32_t)(dxa * dxa + dya2) >> LUT_SHIFT;
            uint32_t ib = (uint32_t)(dxb * dxb + dyb2) >> LUT_SHIFT;
            if (ia >= LUT_N) ia = LUT_N - 1;
            if (ib >= LUT_N) ib = LUT_N - 1;

            uint32_t f = (uint32_t)s_lut[ia] + (uint32_t)s_lut[ib];
            uint32_t a;
            if (f <= F_LO) {
                a = 0;
            } else if (f >= F_HI) {
                a = 255;
            } else {
                a = ((f - F_LO) * 255u) / (F_HI - F_LO);
            }

            if (a == 0 && ring_amt > 4) {
                int32_t dxc = x - CX;
                uint32_t d2c = (uint32_t)(dxc * dxc + dyc2);
                if ((d2c >= ring_in[0] && d2c <= ring_out[0])) a = ring_a[0];
                else if ((d2c >= ring_in[1] && d2c <= ring_out[1])) a = ring_a[1];
            }

            row[x] = a ? rgb565(mix8(pr, ar, a), mix8(pg, ag, a), mix8(pb, ab, a))
                       : paper16;
        }
    }

    if (s_particles_live) {
        step_particles();
        draw_particles(accent);
    }

    // Last, so the mark is never drawn under the drifting particles SUCCESS
    // left behind.
    if (s_state == UI_ORB_CONFIRMED) draw_check();
}

// ---------------------------------------------------------------------------
static void tick(lv_timer_t *t)
{
    (void)t;
    if (s_state == UI_ORB_OFF) return;
    s_phase++;

    int64_t t0 = esp_timer_get_time();
    render();
    int64_t t1 = esp_timer_get_time();
    lv_obj_invalidate(s_canvas);

    // Measured, not assumed: pixel-math cost and the achieved wall-clock rate.
    // Reported once every 90 frames so it costs nothing to leave in.
    static uint32_t frames; static int64_t win_start, busy_us;
    busy_us += (t1 - t0);
    if (++frames >= 90) {
        int64_t span = t1 - win_start;
        if (win_start) {
            ESP_LOGI(TAG, "%u frames in %lld ms => %lld fps, render %lld us/frame",
                     (unsigned)frames, span / 1000,
                     (long long)(frames * 1000000LL / (span ? span : 1)),
                     (long long)(busy_us / frames));
        }
        frames = 0; busy_us = 0; win_start = t1;
    }
}

lv_obj_t *orb_attach(lv_obj_t *parent)
{
    for (int i = 0; i < 64; i++) {
        s_sin[i] = (int16_t)(sinf((float)i * 6.28318530718f / 64.0f) * 256.0f);
    }

    s_buf = heap_caps_malloc(ORB_W * ORB_H * sizeof(uint16_t), MALLOC_CAP_8BIT);
    if (!s_buf) {
        ESP_LOGE(TAG, "no room for the %ux%u canvas (%u B); running without the orb",
                 ORB_W, ORB_H, (unsigned)(ORB_W * ORB_H * sizeof(uint16_t)));
        return NULL;                 // the rest of the UI works without it
    }
    ESP_LOGI(TAG, "canvas %ux%u up, %u B", ORB_W, ORB_H,
             (unsigned)(ORB_W * ORB_H * sizeof(uint16_t)));

    uint16_t paper16 = rgb565((UI_PAPER >> 16) & 0xFF, (UI_PAPER >> 8) & 0xFF, UI_PAPER & 0xFF);
    for (int i = 0; i < ORB_W * ORB_H; i++) s_buf[i] = paper16;

    s_canvas = lv_canvas_create(parent);
    lv_canvas_set_buffer(s_canvas, s_buf, ORB_W, ORB_H, LV_COLOR_FORMAT_RGB565);
    lv_obj_add_flag(s_canvas, LV_OBJ_FLAG_HIDDEN);

    e_r = ((UI_SKY >> 16) & 0xFF) << FX;
    e_g = ((UI_SKY >> 8)  & 0xFF) << FX;
    e_b = ( UI_SKY        & 0xFF) << FX;

    s_timer = lv_timer_create(tick, FRAME_MS, NULL);
    lv_timer_pause(s_timer);          // nothing to draw until orb_set() says so
    return s_canvas;
}

void orb_set_frugal(bool frugal)
{
    if (frugal == s_frugal) return;
    s_frugal = frugal;
    ESP_LOGI(TAG, "frugal %d -> %d (%d fps)", (int)!frugal, (int)frugal,
             frugal ? 1000 / FRAME_MS_FRUGAL : 1000 / FRAME_MS);
    // orb_attach() may have failed to allocate, in which case there is no
    // timer and nothing to slow down.
    if (s_timer) lv_timer_set_period(s_timer, frugal ? FRAME_MS_FRUGAL : FRAME_MS);
}

void orb_set(ui_orb_state_t state, uint8_t proximity)
{
    if (!s_canvas) return;

    s_prox = proximity;
    if (state == s_state) return;

    // Success is the one state that fires a one-shot effect on entry.
    if (state == UI_ORB_SUCCESS) seed_particles();

    ESP_LOGI("spflow", "orb %d -> %d prox=%u", (int)s_state, (int)state, (unsigned)proximity);
    s_state    = state;
    s_state_ms = esp_timer_get_time() / 1000;

    if (state == UI_ORB_OFF) {
        lv_obj_add_flag(s_canvas, LV_OBJ_FLAG_HIDDEN);
        lv_timer_pause(s_timer);
    } else {
        lv_obj_remove_flag(s_canvas, LV_OBJ_FLAG_HIDDEN);
        lv_timer_resume(s_timer);
    }
}

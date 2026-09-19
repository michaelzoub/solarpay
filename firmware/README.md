# SolarPay native firmware

A dedicated SolarPay payment device. The badge boots straight into SolarPay —
there is no launcher, no Lua runtime, no stock apps.

Target: ESP32-C3-MINI-1-N4, ESP-IDF **v5.5.3** (the badge's pinned version).

## Build and flash

```bash
. ~/esp/esp-idf/export.sh
cd firmware/solarpay
idf.py build
idf.py -p /dev/cu.usbmodemXXXX flash monitor
```

If esptool reports "No serial data received", hold **Start (GPIO9)** while
plugging in USB, then retry. A blank screen in that state is download mode, not
a brick. See [`../docs/RECOVERY.md`](../docs/RECOVERY.md).

## The two modes

Both badges run one identical image. The mode is picked on the home screen with
**LEFT/RIGHT** and **A** — or entered automatically, which is the normal case:

| | How it enters | Needs USB? |
|---|---|---|
| **Merchant** | A checkout arrives over USB | Yes — it is the till |
| **Sender** | It hears a live checkout over the air | **No** — battery only |

The sender is deliberately cable-free. It learns the amount from the merchant's
ESP-NOW broadcast, so a payer carries an untethered badge.

## Paying

1. The laptop pushes a checkout to the merchant badge over USB.
2. The merchant broadcasts it in the clear and arms. The payer must be able to
   read the amount *before* deciding to tap, so this is outside the link.
3. Any sender in range shows the amount and arms.
4. **Knock the badges together once.**
5. Both badges name the counterparty and the amount.
6. **The payer presses A.** Only now does an approval move.
7. The merchant emits the same two lines the laptop has always parsed; the
   backend settles on Solana unchanged.

Tapping never moves money. It establishes the link; the payer still confirms.

## Serial contract

Only the merchant uses this. Byte-identical to what the Lua apps emitted, so
`server/` and `web/badge-serial.js` keep parsing what they always parsed.

Out:

```
SOLARPAY_APPROVAL:SP1:A:<intent>:<badge_id>:<nonce>
SP_EVT|v=3|seq=<n>|role=merchant|type=<kind>|<fields>
```

In (the stock firmware took a file over its console; there is no filesystem
console here, so these are plain lines):

```
SP_INTENT SP1:I:<intent>:<lamports>:<ttl>:<nonce>:<tag>
SP_ITEM   SP1:M:<intent>:<item_name>
SP_CONFIRM <intent>
SP_FAIL    <intent>
```

## How the tap works, and why

The radio is the wrong sensor for "which badge did I tap". RSSI on a 2.4 GHz
antenna behind plastic cannot separate touching from an arm's length away; body
blocking and orientation move it more than the last 30 cm does.

A deliberate knock, though, is felt by **both** accelerometers within a few tens
of milliseconds and by no other badge in the room. Measured on this hardware:

| | Shock |
|---|---|
| Badge at rest | 31–237 mg |
| Artifact of pressing a button | 400–800 mg |
| Deliberate knock | 1259–2674 mg |

The gate is **1200 mg**, above every button artifact and below every real knock.
The accelerometer runs at **±8 g**, not the ±2 g the HAL guide suggests, because
a real knock clips against the ±2 g rail — and clipped magnitudes all look alike
to the comparison in condition 5 below.

A peer becomes the counterparty only if **all** of these hold:

1. it is armed — and a badge arms only while a checkout is live;
2. its smoothed RSSI is at or above −70 dBm;
3. we felt an impact in the last 1200 ms;
4. it reported one within ±150 ms of ours;
5. the two impacts were of comparable strength (≥25% ratio);
6. its role is the opposite of ours;
7. it is the **only** peer satisfying 1–6. Two candidates refuses both.

The decision waits **220 ms** after our own knock before deciding anything.
Acting on the first qualifying frame would let whichever badge transmits first
win, before an equally valid second candidate had announced itself.

Knock frames carry `dt_ms` — *milliseconds since my impact*, not a timestamp —
so the two badges never need a shared clock.

## Authentication

On pairing the badges run an **X25519 ECDH** exchange and derive

```
session_key = SHA256(shared_secret ‖ min(sid) ‖ max(sid))
```

Order-independent, so both sides derive the same key without agreeing who is
first, and bound to both session ids so a recorded handshake cannot be replayed
into a different session. The all-zero shared secret is rejected.

Every payment frame then carries a **truncated HMAC-SHA256**, verified in
constant time, with sequence numbers, acknowledgements, 120 ms retries and a
2.5 s deadline.

This is the part the Lua implementation could not do. `docs/BADGE_ARCHITECTURE.md`
§5 recorded the limitation honestly: the channel was a plaintext broadcast, and
"the CRC is integrity, not a MAC". It is a MAC now, and an approval cannot be
forged or replayed by a badge that merely overheard the traffic.

## Layout

```
firmware/solarpay/
  partitions.csv              byte-identical to the stock table
  sdkconfig.defaults
  components/bsp/             ST7789+LVGL, 74HC165 buttons, WS2812, SC7A20
  components/splink/          SPL2 tap link over ESP-NOW
  components/ui/              the SolarPay screens
  components/spconsole/       the laptop-facing serial contract
  main/main.c                 home screen, sender mode, merchant mode
```

The partition table is unchanged from stock on purpose: the 4 MB backup stays a
straight full-flash restore image. `idf.py flash` writes only `0x0`, `0x8000`
and `0x10000` — it never erases `nvs` (badge identity and RF calibration) or
`storage`. **No eFuse or security setting is touched.**

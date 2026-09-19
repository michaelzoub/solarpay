# Badge-to-badge SolarPay: architecture and findings

Investigated 2026-09-19 against a physical Hack the North 2026 Hacker Badge on
`/dev/cu.usbmodem1101`. Everything below marked as a measurement was read off
that badge, not inferred.

---

## 0. Running it

### Once, per machine

```bash
python3 -m venv ~/.esp-venv && ~/.esp-venv/bin/pip install esptool   # for backup/restore
brew install lua                                                    # for the link-layer tests
```

### Off-hardware checks (no badge needed)

```bash
npm test          # 41 assertions, includes the Lua suite when lua is installed
npm run test:lua  # 55 link-layer assertions over a simulated multi-badge radio bus
npm run badge:build   # expand the apps and check the 64 KiB main.lua limit
```

### Back up each badge before touching it

```bash
export ESPTOOL="$HOME/.esp-venv/bin/python -m esptool"
npm run badge:backup -- badge-b /dev/cu.usbmodemXXXX
```

### Prove two badges can find each other (do this first)

Connect badge 1 by USB, make sure it is awake (press START — it sleeps after
300 s idle and then ignores USB entirely), close the official Badge IDE and any
other serial monitor, then:

```bash
npm run badge:pair
```

Repeat for badge 2. Then on each badge open **SolarPay Link Test** from the
launcher and:

1. Press **UP** on one badge so it reads `MERCHANT`; leave the other on `SENDER`.
   They will not pair with a matching role.
2. Press **A** on both. Both show `ARMED`.
3. Watch the RSSI bar as you bring them together. The bar turns green and the
   LEDs go cyan once the smoothed RSSI crosses the gate.
4. Knock them together once, firmly.

Both should show **PAIRED** with the other's session id, flash green, and
exchange a `HELLO FROM <badge id>` message over the link.

Watch what is happening with `npm run badge:logs` on either badge — the app logs
`SP_EVT|...|type=impact`, `type=paired`, `type=refused` and the link layer's own
`SPL1|...` lines.

**Things to try deliberately**, because refusing is the point:

- knock one badge on the table by itself → nothing pairs
- hold them 30 cm apart and knock both at once → nothing pairs
- set both to `SENDER` → nothing pairs
- with a third badge armed and touching, knock all three → both refuse and show
  `REFUSED - n BADGES KNOCKED`

### Calibrate the gate

The number under the bar is the live smoothed RSSI and the configured gate. Hold
the badges where *you* would call it a deliberate tap, read the value, and set
`RSSI_GATE` in `badges/lib/splink.lua` a few dB below it. Rebuild and reinstall.

### Then the real apps

```bash
npm run badge:apps      # installs SolarPay Sender and SolarPay Merchant
```

or install them the usual way from the website, which now serves the expanded
sources automatically. The checkout flow is unchanged except for the tap:

1. Create the checkout on the laptop as before; the merchant badge broadcasts it.
2. The sender badge shows the amount and arms.
3. **Knock the badges together.** Both show the pairing.
4. The sender shows `PAY <amount> TO <merchant>` — press **A** to confirm.
5. The merchant emits the same approval line it always did and the laptop
   settles on Solana exactly as before.

---

## 1. What the badge actually is

| | |
|---|---|
| SoC | **ESP32-C3** (QFN32), silicon revision v0.4, single-core RISC-V |
| Clock | **80 MHz** (`cpu_start: cpu freq: 80000000 Hz`, `Unicore app`) |
| Flash | 4 MB embedded XMC (mfr 0x46 dev 0x4016), DIO @ 80 MHz |
| RAM | ~161 KiB free at `heap_init`; **~77 KiB free / 65 KiB largest block** once an app is running |
| Radios | Wi-Fi 4 and Bluetooth LE 5.0, one shared 2.4 GHz antenna |
| Accelerometer | **SC7A20H** (`WHO_AM_I` 0x11) — LIS2DH12-class, has hardware tap detection |
| Other | LVGL on a 320×240 screen, 6 RGB LEDs, NFC **reader only**, littlefs, Lua **5.5** |
| USB | native USB-Serial/JTAG (`303a:1001`) |
| Firmware | ESP-IDF **v5.5.3-dirty**, project `hello_world`, app `v0.1.2-392-gd3089c4`, built Sep 17 2026 |
| Secure Boot | **disabled** |
| Flash encryption | **disabled** |

### Partition table (read back from flash at 0x8000)

| Label | Type | Offset | Size | Notes |
|---|---|---|---|---|
| `nvs` | data/nvs | 0x009000 | 16 KiB | identity, provisioning, per-app config |
| `phy_init` | data/phy | 0x00d000 | 4 KiB | RF calibration |
| `factory` | app | 0x010000 | 2688 KiB | the entire stock firmware |
| `storage` | data/littlefs | 0x2b0000 | 1280 KiB | `/littlefs` — apps, appdata, assets |
| *(unallocated)* | | 0x3f0000 | 64 KiB | verified all `0xFF` |

Two things matter here more than anything else in this document:

1. **There is no OTA partition and no `otadata`.** The badge boots one fixed
   image. There is no second slot to stage custom firmware into, no rollback,
   and no way to try custom firmware without overwriting the only copy of the
   stock one.
2. **The stock app already fills its partition.** The image runs to roughly
   0x297698, about 2.53 MiB inside a 2.625 MiB partition — roughly **95 KiB of
   headroom**. There is not room to bolt a second radio stack onto it even if we
   had the source.

### What is linked into the stock firmware

Strings in `factory.bin` show NimBLE (`ble_hs`, "advertising setup (NimBLE)",
"scan start (NimBLE)"), LVGL, littlefs and Lua 5.5. There is **no Wi-Fi stack**:
no `net80211`, no `pp` task, no `esp_wifi` init logging. The `ESP_ERR_ESPNOW_*`
strings that do appear are just entries in the `esp_err_to_name` table, which is
compiled in wholesale — they are not evidence of ESP-NOW code.

So `badge.radio` is **BLE advertising plus passive scanning**, not a connection
and not ESP-NOW. That is why you get a MAC and an RSSI per frame but no link.

### One stock bug worth knowing

The console command `radio` **panics the firmware** and reboots the badge:

```
badge> radio
Guru Meditation Error: Core 0 panic'ed (Load access fault).
MEPC : 0x420827f6   MCAUSE : 0x00000005   MTVAL : 0x00000014
```

`radio probe` never gets a chance to run. Avoid that command; it is not caused
by anything in this repo.

---

## 2. Why the Lua apps could not do this reliably

The premise that the radio is "disabled for Lua apps" is not quite right, and
the correction matters because it changes the fix. `badge.radio` **is
available**, and `solarpay_merchant.lua` was already using it:
`enable()`, `send()` (1–44 bytes), `on_recv(mac, rssi, payload)`, `mac()`,
`dropped()`. What is restricted is its *shape*:

- Every Lua frame is tagged `LUA1` and RX is filtered to it, so scripts can
  neither send nor see the system bump/sync frames the stock Share and Sync apps
  use. The firmware's own bump handshake is not reachable from Lua.
- It is a **broadcast** channel. Every armed badge in the room hears every
  frame. There is no addressing, no pairing, no connection.
- 44 bytes per frame, an 8-slot RX ring drained at most 4 frames per tick, and
  drops are silent apart from `dropped()`.
- No crypto primitives. No `pcall`, no `os`, no `coroutine`.
- `disable()` takes about 2 s, and returning HOME after using the radio reboots
  the badge to reclaim Bluetooth's RAM.

Given a broadcast channel, the only question that matters for a tap payment is
*which* badge did I tap — and the old code answered it with a single number:

```lua
-- badges/solarpay_merchant.lua, before this change
if rssi>=-62 then return "touching" end
if rssi>=-82 then return "near" end
```

That comment in the original source records the whole problem: the thresholds
started at −55/−68, never fired through the enclosure and lanyard, and were
widened until they did. But −62 dBm is not "touching" on these badges and
−82 dBm is most of a room. **RSSI on a 2.4 GHz whip antenna behind plastic
cannot separate "touching" from "an arm's length away"**; body blocking and
orientation move it more than the last 30 cm of distance do. Widening the gate
made approvals fire, at the cost of making "very strong proximity" meaningless.

On top of that, the approval itself was a plaintext broadcast:

```lua
badge.radio.send("SP1:A:"..intent..":"..my_id..":"..nonce)
```

Any badge that had heard the intent could replay or forge it, there was no
acknowledgement, and the sender displayed PAID whether or not the merchant ever
received it.

So the real deficiencies were **proximity discrimination, addressing, and
delivery** — not access to the radio.

---

## 3. Patch the stock firmware, or write custom firmware?

**Neither, and this is the main recommendation of this document.**

### Patching is not available

The stock firmware is closed. Hack the North publishes the badge *hardware*
design ([`badge-hardware`](https://github.com/hackathon/badge-hardware)) but no
firmware source; the official brief in `README.md` says explicitly that
"repository access, terminal commands, and development tools are not required",
and the one public project that runs custom code on this badge
([drone-hacking](https://github.com/aryan-vasudevan/drone-hacking)) wrote its
firmware from scratch rather than extending the stock image. Without source
there is no way to add a `solarpay.*` native Lua binding, no way to add a native
background service, and no way to expose a native radio API — those all require
recompiling the firmware that owns the Lua VM.

### Custom firmware is possible, but it costs everything the brief asks to keep

It is technically wide open: Secure Boot and flash encryption are both off, so
the flash can be dumped and rewritten freely over USB-Serial-JTAG. But:

- There is **one app partition**. Installing custom firmware overwrites the
  launcher, all 60-odd stock apps, Share, Sync, the Lua runtime and the badge's
  whole app environment. Requirement 1 of the brief — do not replace the apps,
  filesystem, launcher, or Lua runtime — cannot survive it.
- Bringing up **ESP-NOW means bringing up Wi-Fi**, and pairing still needs BLE
  or a second Wi-Fi channel for discovery. Software coexistence on a
  single-core C3 with ~77 KiB of free heap and a running LVGL UI is a real
  engineering project, not a flag.
- You would then have to reimplement the launcher, the Lua VM, LVGL screens and
  the app registry to get back to where you started.

The escape hatch is preserved rather than taken: a verified full-flash backup
and a restore script exist (§7), so this decision is reversible at any point.

### What is actually achievable

Everything the "native layer" was supposed to provide — peer discovery,
proximity verification, retries, acknowledgements, timeouts, message integrity —
is protocol work, not radio work. **None of it needs native code.** The one
thing native code would genuinely buy is ESP-NOW's lower latency, and latency
was never the failure: discrimination was.

So the link layer is implemented in Lua, shared by all three apps, and
tested off-hardware. The Lua apps, launcher, filesystem and runtime are
untouched.

---

## 4. The tap mechanism, and why

**Bilateral bump correlation, gated by RSSI, bounded by a short arming window,
finished by an explicit press.**

The insight is that the radio is the wrong sensor for the question. A deliberate
knock between two badges is felt by **both** accelerometers within a few tens of
milliseconds, and by no other badge in the room — however close or however
armed. Simultaneity is a far sharper discriminator than signal strength, and the
SC7A20H gives it for free.

A peer becomes the counterparty only if **all** of these hold:

1. it is **armed** — and a badge only arms when there is a live payment request;
2. its smoothed RSSI is at or above the gate (default **−70 dBm**, deliberately loose — see below);
3. **we** felt an impact, within the last 1.2 s;
4. **it** reported an impact within **±150 ms** of ours;
5. the two impacts were of comparable strength;
6. its role is the opposite of ours (a sender pairs only with a merchant);
7. it is the **only** peer satisfying 1–6. Two candidates → refuse both and say
   so. The code never picks the stronger one.

Then both screens name the counterparty and the amount, and **the payer presses
A**. Nothing about touching two badges together moves money on its own.

Condition 7 has a subtlety that a first implementation gets wrong: deciding as
soon as the first qualifying frame arrives lets whichever badge transmits first
win, before a second equally-valid candidate has had a chance to announce
itself. The link therefore waits `PAIR_SETTLE` (220 ms) after its own knock
before deciding anything — slow on purpose. `test/splink.test.lua` has the case
that forced this.

### Alternatives considered

| Option | Why not |
|---|---|
| **ESP-NOW** | Not in the stock firmware; needs custom firmware, which costs the whole stock environment. It would also solve latency, which was not the problem. |
| **NFC** | Reader only — `badge.nfc` can read a card's UID and NDEF text but there is no Lua tag-writing or card-emulation API, so two badges cannot NFC each other. |
| **RSSI alone, tightened** | Already tried in this repo and already failed; see §2. |
| **BLE TX-power reduction** | Not exposed to Lua, and it would shrink range for discovery too. |
| **One-sided tap (old behaviour)** | A badge cannot tell your deliberate knock from you setting your badge down near someone. |
| **Simultaneous button press** | Works, but it is a worse UX than a tap and the brief asks for a tap. It survives as the confirmation step. |

### Keeping the radio quiet

The radio is enabled in `on_enter` (BLE startup is expensive and cannot be
done per-tap) but pairing is **armed only by a live payment request** and
disarmed the moment the intent clears, is cancelled, expires, or settles. Arming
expires by itself after 20 s. Between payments the app sends nothing but the
merchant's intent broadcast, and outside the app the registry disables the radio
entirely.

---

## 5. The protocol (SPL1)

All frames are fixed-width ASCII with a CRC-16/CCITT-FALSE trailer, and every
frame fits the 44-byte limit (asserted by test).

```
SPL1 H <role:1> <sid:4> <armed:1>                    <crc:4>   beacon
SPL1 K <sid:4> <dt:3> <mag:2>                        <crc:4>   "I was just knocked"
SPL1 P <sid:4> <psid:4> <dt:3> <mag:2>               <crc:4>   pair request
SPL1 C <sid:4> <psid:4>                              <crc:4>   pair confirm
SPL1 D <lid:4> <seq:1> <cnt:1> <body:0..24>          <crc:4>   data fragment
SPL1 A <lid:4> <seq:1>                               <crc:4>   ack
SPL1 X <lid:4> <code:1>                              <crc:4>   close
```

`dt` is *milliseconds since my impact*, not a timestamp, so the two badges never
need a shared clock. `lid` is derived independently by both sides from the two
session ids, which buys back the bytes a full address pair would cost.

The flow:

1. The laptop writes `intent.txt`; the merchant loads it on **START** and arms.
2. The merchant broadcasts the intent in the clear, as before — the payer has to
   be able to read the amount *before* deciding to tap.
3. The sender receives the intent, shows it, and arms.
4. The badges are knocked together. Both feel it; both broadcast `K`.
5. After the settle delay each side checks the seven conditions. The
   higher session id sends `P`; the other answers `C`. `P` is retransmitted
   until confirmed or the 900 ms handshake deadline passes.
6. Both screens show the pairing. The merchant shows "confirm on payer".
7. The payer presses **A**. The approval goes over the link as acked,
   retransmitted, fragmented data.
8. The merchant validates the intent and nonce and emits **exactly the same two
   lines it always did** — `SOLARPAY_APPROVAL:SP1:A:…` and
   `SP_EVT|…|type=approval_received|intent=…|customer_badge_id=…|nonce=…`. The
   laptop, backend, signing and Solana submission are untouched.

### What this does and does not protect against

It reliably prevents the realistic failure: paying the wrong nearby badge, or
paying by accident. It does **not** provide cryptographic authentication. The
channel is plaintext broadcast and Lua has no crypto primitives, so a
deliberately hostile badge that is in physical contact range, armed in the
opposite role, inside the window, and knocked at the same instant could in
principle pair. The CRC is integrity, not a MAC.

That is an honest limit of doing this on-badge, and it is acceptable here
because the badge is not the authority: the backend verifies the badge→wallet
mapping and the one-time nonce before it signs anything, and the payer has to
read a screen and press a button. Anyone wanting real on-badge authentication
needs a pre-shared key per badge pair, which means custom firmware — see §3.

---

## 6. What changed

| File | Change |
|---|---|
| `badges/lib/splink.lua` | **new** — the whole link layer. Pure Lua, no badge API calls, dependency-injected clock/radio/RNG so it runs on a host. |
| `badges/solarpay_pair.lua` | **new** — two-badge pairing proof of concept with live RSSI calibration readout. No payments. |
| `badges/solarpay_customer.lua` | Pairs instead of RSSI-guessing; adds an explicit confirm screen; approval now goes over the link. Dead broadcast-approval code removed. |
| `badges/solarpay_merchant.lua` | Arms on intent load; accepts approval only over a paired link; keeps the intent broadcast and both laptop-facing log lines byte-identical. |
| `server/badge-source.js` | **new** — expands `--#include` when an app is read, so the website, the CLI installer and the tests all serve the same expanded app and no generated file can drift. |
| `server/app.js` | Serves expanded sources from both badge-app endpoints. |
| `tools/build-badge-apps.js` | **new** — writes expanded copies to `badges/build/` and checks the 64 KiB limit. Not on any install path. |
| `tools/install-badge-app.js` | **new** — installs any app over USB; detects a sleeping badge and pads a stalled `put` instead of wedging the console. |
| `test/splink.test.lua` | **new** — 55 assertions over a simulated multi-badge radio bus. |
| `test/badge-serial.test.js` | Rewritten for the new design; also runs the Lua suite. |
| `firmware/backup/badge-a/` | Verified full flash dump of the attached badge. |
| `firmware/tools/badge-flash-{backup,restore}.sh` | **new** — per-badge dump and restore. |

Unchanged on purpose: the launcher, every stock app, the filesystem, the Lua
runtime, the firmware, `server/solana.js`, `server/protocol.js`, the settlement
path, and the website's approval handling.

---

## 7. Backup and restore

`firmware/backup/badge-a/` holds a verified 4 MB dump of the attached badge
(base MAC `28:84:85:d7:13:a0`), split per partition, with `SHA256SUMS` that
`shasum -a 256 -c` passes. Nothing destructive has been written to any badge.

```bash
firmware/tools/badge-flash-backup.sh badge-b /dev/cu.usbmodemXXXX   # per badge
firmware/tools/badge-flash-restore.sh badge-b /dev/cu.usbmodemXXXX  # same badge
```

`nvs` (identity) and `phy_init` (RF calibration) are **per badge**. Restore
refuses to run if the attached badge's MAC does not match the backup's, so one
badge's dump cannot be written onto another.

Both scripts need `esptool.py` on `PATH`, or `ESPTOOL=` pointing at it:

```bash
python3 -m venv ~/.esp-venv && ~/.esp-venv/bin/pip install esptool
export ESPTOOL="$HOME/.esp-venv/bin/python -m esptool"   # or add the venv's bin to PATH
```

---

## 8. Open risks

- **Heap.** Each integrated app is now ~30 KB of Lua source once the link layer
  is inlined, against a 96 KiB Lua quota and only ~65 KiB of *contiguous* system
  heap. Source size is not heap usage, but this has not been measured on
  hardware. Validate `solarpay_pair` (25 KB) first; if the integrated apps fail
  to start with "Lua memory limit exceeded", the link layer is the thing to trim.
- **RSSI gate.** −70 dBm is a coarse range filter, not a measurement of "touching".
  It is set loose on purpose: this repo's own history shows badges held edge to
  edge reading below −62, so a tight gate would stop pairing from ever firing,
  and the bump correlation is what actually discriminates. If bystander badges
  at the same table turn out to qualify too often, tighten it with
  `solarpay_pair`, which shows the live smoothed value and the gate together.
- **Not yet run on hardware.** See the verification note in the summary.

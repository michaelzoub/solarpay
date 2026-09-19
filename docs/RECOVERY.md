# Badge recovery and restore

Read this before flashing anything. It is the procedure for putting a badge
back to stock after custom SolarPay firmware has been written to it.

Everything here was verified against the physical badge with base MAC
`28:84:85:d7:13:a0` on `/dev/cu.usbmodem1101`.

---

## 1. Why recovery is possible at all

| Property | Value | Why it matters |
|---|---|---|
| Secure Boot | **Disabled** | The bootloader accepts any unsigned image. |
| Flash Encryption | **Disabled** (`SPI_BOOT_CRYPT_CNT` = 0x0) | The dump is plaintext and can be written back verbatim. |
| eFuse key blocks | all `USER/EMPTY` | Nothing is burned; nothing is one-way. |
| Download mode | ROM, via native USB-Serial-JTAG | Cannot be disabled by a bad app image. |

**No eFuse or security setting is modified by any step in this project.** That
is what keeps recovery available: a bricked *application* is always recoverable
because the ROM bootloader lives in mask ROM and cannot be overwritten.

The realistic worst case is a badge that boots to a blank screen and reboots.
That is still fully recoverable by the procedure in section 3.

---

## 2. Before you flash: prove recovery works

Do this **once per badge, before the first custom write**. It is the whole
safety net.

### 2.1 Take the backup

```bash
export ESPTOOL="$HOME/.esp-venv/bin/python -m esptool"
firmware/tools/badge-flash-backup.sh badge-a /dev/cu.usbmodem1101
```

This writes `firmware/backup/badge-a/` containing the full 4 MB image, each
partition separately, chip and security info, and `SHA256SUMS`.

### 2.2 Verify the backup

```bash
cd firmware/backup/badge-a && shasum -a 256 -c SHA256SUMS
```

All eight files must report `OK`. A backup that does not verify is not a backup.

### 2.3 Prove download mode works — do this before you need it

1. Unplug the badge.
2. **Hold the Start button (GPIO9)** and keep holding it.
3. Plug in USB-C while still holding Start.
4. Release Start after about a second.

The screen stays blank. **That is correct** — a blank screen in this state is
download mode, not a brick. Confirm the chip answers:

```bash
$ESPTOOL --port /dev/cu.usbmodem1101 chip_id
```

It must print `Chip is ESP32-C3 (QFN32)` and the MAC. If it does, recovery is
proven and it is safe to flash.

> Native USB has no auto-reset circuit, which is why the hold-Start step is
> required rather than optional. Most "my badge is bricked" reports are a badge
> that simply was not put into download mode.

---

## 3. Restoring a badge to stock

```bash
export ESPTOOL="$HOME/.esp-venv/bin/python -m esptool"
firmware/tools/badge-flash-restore.sh badge-a /dev/cu.usbmodem1101
```

The script, in order:

1. re-verifies `SHA256SUMS` and refuses to proceed if any file fails;
2. reads the attached badge's base MAC and **refuses if it does not match the
   MAC recorded in the backup's `chip.txt`**;
3. prompts for the literal word `RESTORE`;
4. writes all 4 MB at `0x0` with `--flash_mode dio --flash_freq 80m --flash_size 4MB`;
5. runs `verify_flash` over the whole image.

Then power-cycle the badge. It boots the stock launcher with its original
identity, apps and littlefs contents.

### If the badge will not connect during restore

Put it into download mode first (section 2.3), then re-run the script. In
download mode the running app is irrelevant, so this works even when the custom
firmware is crash-looping.

### Manual equivalent

If the script is unavailable:

```bash
$ESPTOOL --port /dev/cu.usbmodem1101 --baud 921600 write_flash \
  --flash_mode dio --flash_freq 80m --flash_size 4MB \
  0x0 firmware/backup/badge-a/stock-full-4MB.bin

$ESPTOOL --port /dev/cu.usbmodem1101 --baud 921600 \
  verify_flash 0x0 firmware/backup/badge-a/stock-full-4MB.bin
```

---

## 4. The per-badge rule

`nvs` is **specific to one badge**. It holds the badge identity, provisioning,
per-app config *and* the Wi-Fi/BLE RF calibration.

> Measured, 2026-09-19, across two badges: `phy_init` is **entirely `0xFF` on
> both** — blank and unused. RF calibration is not stored there; ESP-IDF keeps
> it in NVS. Earlier notes in this repo describing `phy_init` as per-badge
> calibration are wrong. `nvs` is the partition that actually differs between
> badges (4565 of 16384 bytes), and it is the one that must never be
> cross-written.

Writing badge A's `stock-full-4MB.bin` onto badge B gives badge B badge A's
identity and the wrong RF calibration. **Dump every badge separately, into its
own directory, before touching it.** The restore script enforces this with the
MAC check, but the backup step is on you.

---

## 5. What the custom firmware does and does not change

| Region | Offset | Changed? |
|---|---|---|
| Bootloader | `0x0` | Rebuilt by ESP-IDF v5.5.3, same flash settings (DIO, 80 MHz, 4 MB) |
| Partition table | `0x8000` | **Byte-identical to stock** — verified by md5 against the read-back table |
| `nvs` | `0x9000` | Not written by the flash step; SolarPay stores its own keys here at runtime |
| `phy_init` | `0xd000` | Not written — RF calibration preserved |
| `factory` | `0x10000` | **Overwritten** with the SolarPay app |
| `storage` | `0x2b0000` | Not written by the flash step; stock littlefs contents remain until reformatted |
| eFuses / security | — | **Never touched** |

Keeping the partition table identical is deliberate: it means the stock 4 MB
image remains a straight full-flash restore, and `phy_init` stays exactly where
the stock bootloader expects to find it.

`idf.py flash` writes only `0x0`, `0x8000` and `0x10000` — it does not erase
`nvs`, `phy_init` or `storage`.

---

## 6. Serial port contention on macOS

macOS gives one process exclusive ownership of `/dev/cu.usbmodem*`. If esptool
reports:

```
Could not open /dev/cu.usbmodem1101, the port is busy or doesn't exist.
([Errno 16] Resource busy)
```

something else already owns it — most often a Chrome tab holding a Web Serial
connection (the SolarPay site or the official Badge IDE), or an `idf.py monitor`
left running. Find it and close it:

```bash
lsof /dev/cu.usbmodem1101
```

Disconnect the Web Serial session in that tab, or quit the monitor, then retry.

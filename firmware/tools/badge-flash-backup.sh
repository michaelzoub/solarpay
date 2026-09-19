#!/usr/bin/env bash
# Dump a badge's entire 4 MB flash, split it per partition, and record hashes.
#
#   firmware/tools/badge-flash-backup.sh <name> [port]
#
# <name> becomes firmware/backup/<name>/. Run this once per badge, BEFORE
# writing anything to that badge. nvs and phy_init are per-badge, so one
# badge's dump is not a valid restore image for another badge.
set -euo pipefail

NAME="${1:?usage: badge-flash-backup.sh <name> [port]}"
PORT="${2:-${BADGE_PORT:-/dev/cu.usbmodem1101}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/firmware/backup/$NAME"
ESPTOOL="${ESPTOOL:-esptool.py}"

if [ -e "$OUT/stock-full-4MB.bin" ]; then
  echo "refusing to overwrite an existing backup at $OUT" >&2
  exit 1
fi
mkdir -p "$OUT"

echo "== chip =="
"$ESPTOOL" --port "$PORT" flash_id | tee "$OUT/chip.txt"
echo "== security =="
"$ESPTOOL" --port "$PORT" get_security_info | tee "$OUT/security.txt"

if grep -qi "Flash Encryption: Enabled" "$OUT/security.txt"; then
  echo "WARNING: flash encryption is enabled; this dump is ciphertext." >&2
fi

echo "== reading 4 MB =="
"$ESPTOOL" --port "$PORT" --baud 921600 read_flash 0 0x400000 "$OUT/stock-full-4MB.bin"

python3 - "$OUT" <<'PY'
import sys, os, struct, hashlib
out = sys.argv[1]
blob = open(os.path.join(out, "stock-full-4MB.bin"), "rb").read()
assert len(blob) == 0x400000, f"expected 4 MiB, got {len(blob)}"

for name, off, size in [("bootloader", 0x0, 0x8000), ("partition-table", 0x8000, 0x1000)]:
    open(os.path.join(out, name + ".bin"), "wb").write(blob[off:off + size])

TYPES = {0: "app", 1: "data"}
SUB = {(0, 0): "factory", (1, 0): "ota", (1, 1): "phy", (1, 2): "nvs",
       (1, 0x81): "fat", (1, 0x82): "spiffs", (1, 0x83): "littlefs"}
table, end = [], 0
pt = blob[0x8000:0x9000]
for i in range(0, len(pt), 32):
    e = pt[i:i + 32]
    if e[:2] != b"\xaa\x50":
        break
    t, st = e[2], e[3]
    off, size = struct.unpack("<II", e[4:12])
    label = e[12:28].rstrip(b"\x00").decode()
    table.append((label, TYPES.get(t, t), SUB.get((t, st), hex(st)), off, size))
    open(os.path.join(out, label + ".bin"), "wb").write(blob[off:off + size])
    end = max(end, off + size)

if end < len(blob):
    open(os.path.join(out, "tail.bin"), "wb").write(blob[end:])

with open(os.path.join(out, "PARTITIONS.txt"), "w") as fh:
    for label, t, st, off, size in table:
        fh.write(f"{label:16} {t:5} {st:9} 0x{off:06x} 0x{size:06x} ({size // 1024} KiB)\n")
    if end < len(blob):
        tail = blob[end:]
        blank = tail == b"\xff" * len(tail)
        fh.write(f"{'(unallocated)':16} {'':5} {'':9} 0x{end:06x} 0x{len(tail):06x} "
                 f"({len(tail) // 1024} KiB, all 0xFF: {blank})\n")

with open(os.path.join(out, "SHA256SUMS"), "w") as fh:
    for name in sorted(os.listdir(out)):
        if name.endswith(".bin"):
            digest = hashlib.sha256(open(os.path.join(out, name), "rb").read()).hexdigest()
            fh.write(f"{digest}  {name}\n")

print(open(os.path.join(out, "PARTITIONS.txt")).read())
PY

echo "backup complete: $OUT"

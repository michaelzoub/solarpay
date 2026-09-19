#!/usr/bin/env bash
# Write a badge's own backup image back to that badge, returning it to stock.
#
#   firmware/tools/badge-flash-restore.sh <name> [port]
#
# <name> is the directory under firmware/backup/ created by
# badge-flash-backup.sh FOR THIS SAME BADGE. Restoring one badge's dump onto a
# different badge copies its identity (nvs) and the wrong RF calibration
# (phy_init), so this script refuses unless the base MAC matches.
set -euo pipefail

NAME="${1:?usage: badge-flash-restore.sh <name> [port]}"
PORT="${2:-${BADGE_PORT:-/dev/cu.usbmodem1101}}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/firmware/backup/$NAME"
IMAGE="$SRC/stock-full-4MB.bin"
ESPTOOL="${ESPTOOL:-esptool.py}"

[ -f "$IMAGE" ] || { echo "no image at $IMAGE" >&2; exit 1; }

echo "== verifying backup integrity =="
(cd "$SRC" && shasum -a 256 -c SHA256SUMS)

echo "== identifying the attached badge =="
LIVE="$("$ESPTOOL" --port "$PORT" flash_id)"
echo "$LIVE"
LIVE_MAC="$(printf '%s\n' "$LIVE" | sed -n 's/^MAC: //p' | tr 'A-F' 'a-f')"
SAVED_MAC="$(sed -n 's/^MAC: //p' "$SRC/chip.txt" 2>/dev/null | tr 'A-F' 'a-f')"

if [ -n "$SAVED_MAC" ] && [ "$LIVE_MAC" != "$SAVED_MAC" ]; then
  echo "REFUSING: attached badge is $LIVE_MAC but this backup came from $SAVED_MAC." >&2
  echo "Restore each badge from its own dump." >&2
  exit 1
fi

echo
echo "About to overwrite ALL 4 MB of flash on $PORT (MAC $LIVE_MAC)"
echo "with $IMAGE"
read -r -p "Type RESTORE to continue: " CONFIRM
[ "$CONFIRM" = "RESTORE" ] || { echo "aborted"; exit 1; }

"$ESPTOOL" --port "$PORT" --baud 921600 write_flash --flash_mode dio \
  --flash_freq 80m --flash_size 4MB 0x0 "$IMAGE"

echo "== verifying written flash =="
"$ESPTOOL" --port "$PORT" --baud 921600 verify_flash 0x0 "$IMAGE"
echo "restored. power-cycle the badge."

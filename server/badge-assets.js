import QRCode from "qrcode";

const ICON_SIZE = 42;
const COLORS = {
  ink: 0x10091f,
  purple: 0x9a5cff,
  pink: 0xff4fd8,
  cyan: 0x4debff,
  yellow: 0xffe45e,
  white: 0xfff8ff,
};

function rgb565(rgb) {
  const red = (rgb >> 16) & 0xff;
  const green = (rgb >> 8) & 0xff;
  const blue = rgb & 0xff;
  return ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
}

function encodeLvglImage(width, height, pixelAt) {
  const pixels = width * height;
  const output = Buffer.alloc(12 + pixels * 3);
  output[0] = 0x19;
  output[1] = 0x14;
  output.writeUInt16LE(width, 4);
  output.writeUInt16LE(height, 6);
  output.writeUInt32LE(width * 2, 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const { color, alpha = 0xff } = pixelAt(x, y);
      output.writeUInt16LE(rgb565(color), 12 + index * 2);
      output[12 + pixels * 2 + index] = alpha;
    }
  }
  return output;
}

function inRoundedSquare(x, y) {
  if (x >= 5 && x <= 36 && y >= 1 && y <= 40) return true;
  if (x >= 1 && x <= 40 && y >= 5 && y <= 36) return true;
  const cornerX = x < 21 ? 5 : 36;
  const cornerY = y < 21 ? 5 : 36;
  return (x - cornerX) ** 2 + (y - cornerY) ** 2 <= 16;
}

function senderPixel(x, y) {
  if (!inRoundedSquare(x, y)) return { color: COLORS.ink, alpha: 0 };
  let color = COLORS.purple;
  const coin = (x - 19) ** 2 + (y - 23) ** 2 <= 11 ** 2;
  if (coin) color = COLORS.yellow;
  if (coin && (x - 19) ** 2 + (y - 23) ** 2 <= 7 ** 2) color = COLORS.ink;
  const arrow = (x >= 21 && x <= 33 && y >= 9 && y <= 13)
    || (x >= 29 && x <= 33 && y >= 9 && y <= 22)
    || (x >= 20 && x <= 31 && Math.abs((x + y) - 43) <= 2);
  if (arrow) color = COLORS.white;
  return { color };
}

function merchantPixel(x, y) {
  if (!inRoundedSquare(x, y)) return { color: COLORS.ink, alpha: 0 };
  let color = COLORS.ink;
  if (x >= 8 && x <= 33 && y >= 17 && y <= 34) color = COLORS.white;
  if (x >= 6 && x <= 35 && y >= 11 && y <= 16) color = (Math.floor((x - 6) / 5) % 2) ? COLORS.pink : COLORS.cyan;
  if (x >= 11 && x <= 17 && y >= 22 && y <= 34) color = COLORS.purple;
  if (x >= 22 && x <= 30 && y >= 21 && y <= 28) color = COLORS.cyan;
  if (y >= 35 && y <= 37 && x >= 6 && x <= 35) color = COLORS.yellow;
  return { color };
}

export function encodeLvglIcon(role) {
  return encodeLvglImage(ICON_SIZE, ICON_SIZE, role === "merchant" ? merchantPixel : senderPixel);
}

const SOLANA_LOGO_WIDTH = 26;
const SOLANA_LOGO_HEIGHT = 16;
const SOLANA_PURPLE = [0x99, 0x45, 0xff];
const SOLANA_GREEN = [0x14, 0xf1, 0x95];

function solanaGradient(x) {
  const t = x / (SOLANA_LOGO_WIDTH - 1);
  const r = Math.round(SOLANA_PURPLE[0] + (SOLANA_GREEN[0] - SOLANA_PURPLE[0]) * t);
  const g = Math.round(SOLANA_PURPLE[1] + (SOLANA_GREEN[1] - SOLANA_PURPLE[1]) * t);
  const b = Math.round(SOLANA_PURPLE[2] + (SOLANA_GREEN[2] - SOLANA_PURPLE[2]) * t);
  return (r << 16) | (g << 8) | b;
}

function solanaLogoPixel(x, y) {
  const barHeight = 4;
  const gap = 2;
  const skew = 8;
  const barWidth = SOLANA_LOGO_WIDTH - skew;
  const bars = [
    { top: 0, mirrored: false },
    { top: barHeight + gap, mirrored: true },
    { top: (barHeight + gap) * 2, mirrored: false },
  ];
  for (const bar of bars) {
    const localY = y - bar.top;
    if (localY < 0 || localY >= barHeight) continue;
    const progress = bar.mirrored ? (barHeight - 1 - localY) / (barHeight - 1) : localY / (barHeight - 1);
    const shift = Math.round(skew * progress);
    if (x < shift || x >= shift + barWidth) continue;
    return { color: solanaGradient(x) };
  }
  return { color: 0x000000, alpha: 0 };
}

export function encodeLvglSolanaLogo() {
  return encodeLvglImage(SOLANA_LOGO_WIDTH, SOLANA_LOGO_HEIGHT, solanaLogoPixel);
}

export function encodeLvglQr(value) {
  const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
  const quiet = 4;
  const doubledSize = (qr.modules.size + quiet * 2) * 2;
  const scale = 12 + doubledSize * doubledSize * 3 <= 16 * 1024 ? 2 : 1;
  const size = (qr.modules.size + quiet * 2) * scale;
  return encodeLvglImage(size, size, (x, y) => {
    const moduleX = Math.floor(x / scale) - quiet;
    const moduleY = Math.floor(y / scale) - quiet;
    const dark = moduleX >= 0 && moduleY >= 0 && moduleX < qr.modules.size && moduleY < qr.modules.size
      && Boolean(qr.modules.data[moduleY * qr.modules.size + moduleX]);
    return { color: dark ? 0x000000 : 0xffffff };
  });
}

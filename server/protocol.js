const PREFIX = "SP1";

export function intentPacket(intent, ttlSeconds, merchantLabel = "SHOP") {
  const nonce = intent.intent_nonce || intent.intentNonce;
  const label = merchantLabel.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 2) || "SP";
  const packet = `${PREFIX}:I:${intent.id}:${intent.amount_lamports}:${ttlSeconds}:${nonce}:${label}`;
  assertPacket(packet);
  return packet;
}

export function intentItemPacket(intent, memo = "") {
  const item = String(memo)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 -]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 28) || "PAYMENT";
  const packet = `${PREFIX}:M:${intent.id}:${item}`;
  assertPacket(packet);
  return packet;
}

export function approvalPacket({ intentId, customerBadgeId, nonce }) {
  const packet = `${PREFIX}:A:${intentId}:${customerBadgeId.slice(0, 16)}:${nonce}`;
  assertPacket(packet);
  return packet;
}

export function parsePacket(packet) {
  if (Buffer.byteLength(packet) > 44) throw new Error("Radio packet exceeds 44 bytes");
  const parts = packet.split(":");
  if (parts[0] !== PREFIX) throw new Error("Unknown radio protocol");
  if (parts[1] === "I" && parts.length === 7) return { type: "intent", intentId: parts[2], amountLamports: Number(parts[3]), ttlSeconds: Number(parts[4]), nonce: parts[5], merchantLabel: parts[6] };
  if (parts[1] === "M" && parts.length === 4) return { type: "item", intentId: parts[2], itemLabel: parts[3].replaceAll("_", " ") };
  if (parts[1] === "A" && parts.length === 5) return { type: "approval", intentId: parts[2], customerBadgeId: parts[3], nonce: parts[4] };
  throw new Error("Malformed radio packet");
}

function assertPacket(packet) {
  if (Buffer.byteLength(packet) > 44) throw new Error("Radio packet exceeds 44 bytes");
}

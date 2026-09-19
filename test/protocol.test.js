import test from "node:test";
import assert from "node:assert/strict";
import { approvalPacket, intentItemPacket, intentPacket, parsePacket } from "../server/protocol.js";

test("radio protocol remains within the badge's 44 byte limit", () => {
  const intent = { id: "01234567", amount_lamports: 10_000_000_000, intent_nonce: "deadbeef123" };
  const encodedIntent = intentPacket(intent, 90);
  const encodedApproval = approvalPacket({ intentId: intent.id, customerBadgeId: "CUSTOMER-1234567", nonce: "deadbeef" });
  const encodedItem = intentItemPacket(intent, "Iced coffee + pastry");
  assert.ok(Buffer.byteLength(encodedIntent) <= 44);
  assert.ok(Buffer.byteLength(encodedApproval) <= 44);
  assert.equal(Buffer.byteLength(encodedIntent), 44);
  assert.deepEqual(parsePacket(encodedIntent), { type: "intent", intentId: intent.id, amountLamports: 10_000_000_000, ttlSeconds: 90, nonce: "deadbeef123", merchantLabel: "SH" });
  assert.equal(parsePacket(encodedApproval).customerBadgeId, "CUSTOMER-1234567");
  assert.ok(Buffer.byteLength(encodedItem) <= 44);
  assert.deepEqual(parsePacket(encodedItem), { type: "item", intentId: intent.id, itemLabel: "Iced coffee pastry" });
});

test("long provisioned badge IDs use a bounded radio reference", () => {
  const packet = approvalPacket({ intentId: "01234567", customerBadgeId: "lilac-hickory-atlas-west", nonce: "deadbeef" });
  assert.equal(parsePacket(packet).customerBadgeId, "lilac-hickory-at");
  assert.ok(Buffer.byteLength(packet) <= 44);
});

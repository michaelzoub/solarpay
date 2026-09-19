import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { MockCustomerBadge, MockRadio, MockTerminalSerial } from "../server/mock-adapters.js";
import { intentPacket } from "../server/protocol.js";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import { MockSolana } from "../server/solana.js";

test("mock USB and radio adapters carry an end-to-end badge approval", async () => {
  const radio = new MockRadio();
  const terminal = new MockTerminalSerial("TERM-001", radio);
  const customer = new MockCustomerBadge("CUST-001", radio);
  radio.on("packet", (packet) => {
    if (packet.startsWith("SP1:A:")) terminal.relayApproval(packet);
  });

  const displayed = new Promise((resolve) => customer.once("display", resolve));
  const relayed = new Promise((resolve) => terminal.once("approval", resolve));
  terminal.sendIntent(intentPacket({ id: "01234567", amount_lamports: 50_000_000, intent_nonce: "deadbeef123" }, 90));
  assert.equal((await displayed).amountLamports, 50_000_000);
  customer.pressA();
  const approval = await relayed;
  assert.equal(approval.intentId, "01234567");
  assert.equal(approval.customerBadgeId, "CUST-001");
  assert.equal(approval.nonce, "deadbeef123");
});

test("sender and merchant complete the full checkout through radio, signing, and settlement", async (t) => {
  const store = new Store(":memory:", Buffer.alloc(32, 5).toString("base64"));
  t.after(() => store.close());
  const solana = new MockSolana();
  const app = createApp({
    store,
    solana,
    config: {
      apiKeys: new Map([["e2e-secret", "e2e-merchant"], ["other-secret", "e2e-sender"]]),
      adminApiKey: "admin-secret",
      solanaMode: "mock",
      intentTtlSeconds: 90,
      payerAirdropLamports: 2_000_000_000,
      feeReserveLamports: 5_000,
    },
  });
  const auth = { authorization: "Bearer e2e-secret" };
  const merchantProfile = (await request(app).post("/api/badges").set(auth).send({ role: "merchant", badgeId: "cedar-river-north" }).expect(201)).body;
  const senderProfile = (await request(app).post("/api/badges").set("authorization", "Bearer other-secret").send({ role: "customer", badgeId: "lilac-hickory-atlas-west" }).expect(201)).body;

  const radio = new MockRadio();
  const terminal = new MockTerminalSerial(merchantProfile.badgeId, radio);
  const sender = new MockCustomerBadge(senderProfile.badgeId, radio);
  radio.on("packet", (packet) => { if (packet.startsWith("SP1:A:")) terminal.relayApproval(packet); });

  const intent = (await request(app).post("/api/intents").set(auth)
    .send({ terminalBadgeId: merchantProfile.badgeId, amountLamports: 25_000_000, memo: "E2E" }).expect(201)).body;
  const displayed = new Promise((resolve) => sender.once("display", resolve));
  const relayed = new Promise((resolve) => terminal.once("approval", resolve));
  terminal.sendIntent(intent.radioPacket);
  assert.equal((await displayed).amountLamports, 25_000_000);
  sender.pressA();
  const approvalPacket = await relayed;

  const approval = (await request(app).post(`/api/intents/${intent.id}/approve`).set(auth)
    .send({ customerBadgeId: approvalPacket.customerBadgeId, intentNonce: approvalPacket.nonce }).expect(200)).body;
  const settled = (await request(app).post(`/api/intents/${intent.id}/submit`).set(auth)
    .send({ signedTransaction: approval.signedTransaction }).expect(200)).body;
  terminal.setResult(settled.intent.status);

  assert.equal(settled.intent.status, "confirmed");
  assert.equal(await solana.getBalance(merchantProfile.publicKey), 25_000_000);
  assert.equal(await solana.getBalance(senderProfile.publicKey), 1_975_000_000);
});

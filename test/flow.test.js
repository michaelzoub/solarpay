import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../server/app.js";
import { Store } from "../server/db.js";
import { MockSolana } from "../server/solana.js";

function fixture(ttl = 90_000) {
  const store = new Store(":memory:", Buffer.alloc(32, 7).toString("base64"));
  const solana = new MockSolana();
  const config = { apiKeys: new Map([["laptop-secret", "laptop-1"], ["other-secret", "laptop-2"]]), adminApiKey: "admin-secret", solanaMode: "mock", intentTtlSeconds: ttl / 1000 };
  const app = createApp({ config, store, solana });
  const merchant = solana.generateWallet();
  const customer = solana.generateWallet();
  store.registerBadge({ badgeId: "TERM-001", role: "merchant", ...merchant });
  store.registerBadge({ badgeId: "CUST-001", role: "customer", ...customer });
  solana.fund(customer.publicKey, 2_000_000_000);
  return { app, store, solana, merchant, customer };
}

const auth = { authorization: "Bearer laptop-secret" };

test("guided setup creates a badge profile and serves its installable app", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const created = await request(f.app).post("/api/badges").set(auth).send({ role: "customer", badgeId: "lilac-hickory-atlas-west" }).expect(201);
  assert.equal(created.body.badgeId, "lilac-hickory-atlas-west");
  assert.deepEqual(created.body.roles, ["customer", "merchant"]);
  assert.equal(created.body.funding.status, "confirmed");
  assert.equal(created.body.funding.lamports, 2_000_000_000);
  assert.equal(await f.solana.getBalance(created.body.publicKey), 2_000_000_000);
  const refilled = await request(f.app).post(`/api/badges/${created.body.badgeId}/airdrop`).set(auth).expect(200);
  assert.equal(refilled.body.funding.status, "confirmed");
  assert.equal(refilled.body.lamports, 4_000_000_000);
  const badges = await request(f.app).get("/api/badges").set(auth).expect(200);
  assert.equal(badges.body.badges.length, 1);
  assert.ok(badges.body.badges.some((badge) => badge.badgeId === created.body.badgeId));
  const appFile = await request(f.app).get("/api/badge-apps/customer").expect(200);
  assert.match(appFile.text, /slug=solarpay_customer/);
  assert.match(appFile.headers["content-disposition"], /solarpay-customer\.lua/);
  const tapLogger = await request(f.app).get("/api/badge-apps/tap").expect(200);
  assert.match(tapLogger.text, /slug=solarpay_tap_logger/);
  assert.match(tapLogger.headers["content-disposition"], /solarpay-tap\.lua/);
  const genericSolarPay = await request(f.app).get("/api/badge-apps/solarpay").expect(200);
  assert.match(genericSolarPay.text, /slug=solarpay_sender\n/);
  assert.match(genericSolarPay.text, /role=customer/);
  assert.doesNotMatch(genericSolarPay.text, /role == "merchant"/);
  const genericMerchantSolarPay = await request(f.app).get("/api/badge-apps/solarpay?role=merchant").expect(200);
  assert.match(genericMerchantSolarPay.text, /slug=solarpay_merchant\n/);
  assert.match(genericMerchantSolarPay.text, /role=merchant/);
  assert.doesNotMatch(genericMerchantSolarPay.text, /role == "customer"/);
  const genericBundle = await request(f.app).get("/api/badge-apps/solarpay-bundle?role=merchant").expect(200);
  assert.match(genericBundle.body.source, /slug=solarpay_merchant\n/);
  assert.equal(genericBundle.body.files[0].path, "icon.bin");
  assert.equal(Buffer.from(genericBundle.body.files[0].data, "base64").length, 5304);
  const personalized = await request(f.app).get(`/api/badges/${created.body.badgeId}/app`).set(auth).expect(200);
  assert.match(personalized.text, new RegExp(created.body.badgeId));
  assert.match(personalized.text, new RegExp(created.body.publicKey));
  assert.doesNotMatch(personalized.text, /__SOLARPAY_WALLET_ADDRESS__/);
  const personalizedSolarPay = await request(f.app).get(`/api/badges/${created.body.badgeId}/solarpay-app`).set(auth).expect(200);
  assert.match(personalizedSolarPay.text, new RegExp(created.body.badgeId));
  assert.match(personalizedSolarPay.text, new RegExp(created.body.publicKey));
  assert.doesNotMatch(personalizedSolarPay.text, /__SOLARPAY_BALANCE__/);
  assert.match(personalizedSolarPay.text, /\|role=customer\|type=/);
  assert.doesNotMatch(personalizedSolarPay.text, /\|role=merchant\|type=/);
  const bundle = await request(f.app).get(`/api/badges/${created.body.badgeId}/solarpay-bundle`).set(auth).expect(200);
  assert.equal(bundle.body.role, "customer");
  assert.match(bundle.body.source, new RegExp(created.body.badgeId));
  assert.doesNotMatch(bundle.body.source, /__SOLARPAY_QR_AVAILABLE__/);
  assert.equal(bundle.body.files[0].path, "icon.bin");
  const senderIcon = Buffer.from(bundle.body.files[0].data, "base64");
  assert.equal(senderIcon.length, 5304);
  assert.equal(senderIcon.readUInt16LE(4), 42);
  assert.equal(senderIcon.readUInt16LE(6), 42);
  assert.equal(bundle.body.files[1].path, "qr.bin");
  const qr = Buffer.from(bundle.body.files[1].data, "base64");
  assert.equal(qr[0], 0x19);
  assert.equal(qr[1], 0x14);
  assert.ok(qr.length < 16 * 1024);
  const sameWalletMerchantBundle = await request(f.app).get(`/api/badges/${created.body.badgeId}/solarpay-bundle?role=merchant`).set(auth).expect(200);
  assert.equal(sameWalletMerchantBundle.body.role, "merchant");
  assert.match(sameWalletMerchantBundle.body.source, /slug=solarpay_merchant/);
  assert.match(sameWalletMerchantBundle.body.source, new RegExp(created.body.publicKey));
  assert.equal(sameWalletMerchantBundle.body.files[0].path, "icon.bin");
  assert.equal(Buffer.from(sameWalletMerchantBundle.body.files[0].data, "base64").length, 5304);

  const merchantProfile = await request(f.app).post("/api/badges").set("authorization", "Bearer other-secret").send({ role: "merchant", badgeId: "cedar-river-north" }).expect(201);
  assert.equal(merchantProfile.body.funding, undefined);
  const merchantBundle = await request(f.app).get(`/api/badges/${merchantProfile.body.badgeId}/solarpay-bundle`).set(auth).expect(200);
  assert.match(merchantBundle.body.source, /\|role=merchant\|type=/);
  assert.doesNotMatch(merchantBundle.body.source, /\|role=customer\|type=/);
  assert.equal(merchantBundle.body.files[0].path, "icon.bin");
});

test("every badge.ui.image asset a SolarPay app's main.lua loads is included in its bundle", async (t) => {
  // A badge has no pcall: a missing image file that badge.ui.image tries to
  // open/decode is a native fault, not a catchable Lua error, and shows up on
  // the physical badge as a silent reboot on every on_enter. This regression-
  // tests the exact bug class where a new badge.ui.image(...) call is added to
  // a Lua app without also adding its asset to every endpoint's `files` array.
  const f = fixture(); t.after(() => f.store.close());
  const created = await request(f.app).post("/api/badges").set(auth).send({ role: "customer", badgeId: "bundle-asset-check" }).expect(201);
  const bundles = [
    await request(f.app).get("/api/badge-apps/solarpay-bundle?role=customer").expect(200),
    await request(f.app).get("/api/badge-apps/solarpay-bundle?role=merchant").expect(200),
    await request(f.app).get(`/api/badges/${created.body.badgeId}/solarpay-bundle`).set(auth).expect(200),
    await request(f.app).get(`/api/badges/${created.body.badgeId}/solarpay-bundle?role=merchant`).set(auth).expect(200),
  ];
  for (const { body } of bundles) {
    const referenced = [...body.source.matchAll(/badge\.ui\.image\([^,]+,\s*"([^"]+)"\)/g)].map((match) => match[1]);
    assert.ok(referenced.length > 0, `expected the ${body.role} app source to reference at least one image asset`);
    const bundled = new Set(body.files.map((file) => file.path));
    for (const assetPath of referenced) {
      // qr.bin is only ever opened behind `if has_qr then`, and has_qr is false
      // whenever __SOLARPAY_QR_AVAILABLE__ was left unsubstituted, so it is
      // legitimately absent from an unpersonalized bundle.
      if (assetPath === "qr.bin" && body.source.includes("__SOLARPAY_QR_AVAILABLE__")) continue;
      assert.ok(bundled.has(assetPath), `${body.role} bundle is missing "${assetPath}", which its main.lua loads via badge.ui.image`);
    }
  }
});

test("every endpoint that serves a badge app expands its --#include directives", async (t) => {
  // The badge has no module loader: `require` does not exist, so the SPL1 link
  // layer reaches main.lua only through the `--#include lib/splink.lua`
  // directive that server/badge-source.js expands on read. An endpoint that
  // reads the .lua with plain readFile ships that directive as an ordinary Lua
  // comment, `splink` resolves to a nil global, and the badge dies at runtime
  // with "attempt to index a nil value (global 'splink')" inside a UI callback.
  const f = fixture(); t.after(() => f.store.close());
  const created = await request(f.app).post("/api/badges").set(auth).send({ role: "customer", badgeId: "include-expansion" }).expect(201);
  const id = created.body.badgeId;
  const sources = [
    ["/api/badge-apps/solarpay", (r) => r.text],
    ["/api/badge-apps/solarpay?role=merchant", (r) => r.text],
    ["/api/badge-apps/solarpay-bundle?role=customer", (r) => r.body.source],
    ["/api/badge-apps/solarpay-bundle?role=merchant", (r) => r.body.source],
    [`/api/badges/${id}/app`, (r) => r.text],
    [`/api/badges/${id}/solarpay-app`, (r) => r.text],
    [`/api/badges/${id}/solarpay-bundle`, (r) => r.body.source],
    [`/api/badges/${id}/solarpay-bundle?role=merchant`, (r) => r.body.source],
  ];
  for (const [url, pick] of sources) {
    const source = pick(await request(f.app).get(url).set(auth).expect(200));
    assert.doesNotMatch(source, /^[ \t]*--#include\b/m, `${url} served an unexpanded --#include`);
    // Expansion is only useful if it actually binds the name the app uses.
    if (/\bsplink\./.test(source)) {
      assert.match(source, /^local splink = \(function\(\)$/m, `${url} uses splink. without binding a local splink`);
    }
  }
});

test("guided setup reuses one badge ID and wallet for the authenticated identity", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const first = await request(f.app).post("/api/badges").set(auth).send({ role: "customer", badgeId: "lilac-hickory-atlas-west" }).expect(201);
  const second = await request(f.app).post("/api/badges").set(auth).send({ role: "merchant", badgeId: "lilac-hickory-atlas-west" }).expect(200);
  assert.equal(second.body.badgeId, first.body.badgeId);
  assert.equal(second.body.publicKey, first.body.publicKey);
  assert.equal(second.body.reused, true);
  assert.equal(second.body.funding, undefined);
});

test("one laptop can own a sender and a merchant badge at the same time", async (t) => {
  // The two-badge payment flow needs both badges registered simultaneously.
  // Scoping ownership by laptop alone meant the second registration RENAMED the
  // first badge's row, so the badge that lost its row failed approval with
  // CUSTOMER_NOT_FOUND.
  const f = fixture(); t.after(() => f.store.close());
  const sender = await request(f.app).post("/api/badges").set(auth)
    .send({ role: "customer", badgeId: "288485d713a0" }).expect(201);
  const merchant = await request(f.app).post("/api/badges").set(auth)
    .send({ role: "merchant", badgeId: "288485eae2b4" }).expect(201);

  assert.notEqual(sender.body.badgeId, merchant.body.badgeId);
  // Distinct wallets: paying yourself is not a payment.
  assert.notEqual(sender.body.publicKey, merchant.body.publicKey);

  // Both must still resolve after the other was registered.
  assert.ok(f.store.walletForReference("288485d713a0"), "sender badge disappeared");
  assert.ok(f.store.walletForReference("288485eae2b4"), "merchant badge disappeared");
});

test("re-registering a role replaces that role's badge and leaves the other alone", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  await request(f.app).post("/api/badges").set(auth).send({ role: "customer", badgeId: "aaaaaaaaaaaa" }).expect(201);
  await request(f.app).post("/api/badges").set(auth).send({ role: "merchant", badgeId: "bbbbbbbbbbbb" }).expect(201);
  await request(f.app).post("/api/badges").set(auth).send({ role: "customer", badgeId: "cccccccccccc" }).expect(200);

  assert.ok(f.store.walletForReference("cccccccccccc"), "replacement sender missing");
  assert.ok(f.store.walletForReference("bbbbbbbbbbbb"), "merchant should be untouched");
});

test("setup replaces a legacy generated ID with the connected physical badge ID", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const wallet = f.solana.generateWallet();
  f.store.registerBadge({ badgeId: "PAY-ABC123", role: "customer", ownerId: "laptop-1", ...wallet });
  const response = await request(f.app).post("/api/badges").set(auth)
    .send({ role: "customer", badgeId: "lilac-hickory-atlas-west" }).expect(200);
  assert.equal(response.body.badgeId, "lilac-hickory-atlas-west");
  assert.equal(response.body.publicKey, wallet.publicKey);
  assert.equal(f.store.walletFor("PAY-ABC123"), null);
});

test("a truncated radio reference resolves one long physical badge ID", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const payer = f.solana.generateWallet();
  f.store.registerBadge({ badgeId: "lilac-hickory-atlas-west", role: "customer", ...payer });
  f.solana.fund(payer.publicKey, 2_000_000_000);
  const intent = await request(f.app).post("/api/intents").set(auth)
    .send({ terminalBadgeId: "TERM-001", amountLamports: 1 }).expect(201);
  const approved = await request(f.app).post(`/api/intents/${intent.body.id}/approve`).set(auth)
    .send({ customerBadgeId: "lilac-hickory-at", intentNonce: intent.body.intentNonce }).expect(200);
  assert.equal(approved.body.intent.customerBadgeId, "lilac-hickory-atlas-west");
});

test("a pending payment can be cancelled only by its owner", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const created = await request(f.app).post("/api/intents").set(auth)
    .send({ terminalBadgeId: "TERM-001", amountLamports: 25_000_000, memo: "Cancelled coffee" }).expect(201);

  await request(f.app).post(`/api/intents/${created.body.id}/cancel`)
    .set("authorization", "Bearer other-secret").expect(404);
  const cancelled = await request(f.app).post(`/api/intents/${created.body.id}/cancel`).set(auth).expect(200);
  assert.equal(cancelled.body.intent.status, "cancelled");

  await request(f.app).post(`/api/intents/${created.body.id}/approve`).set(auth)
    .send({ customerBadgeId: "CUST-001", intentNonce: created.body.intentNonce }).expect(409);
  await request(f.app).post(`/api/intents/${created.body.id}/cancel`).set(auth).expect(409);
});

test("diagnostics export is useful and excludes sensitive wallet data", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const response = await request(f.app).get("/api/diagnostics").set(auth).expect(200);
  assert.equal(response.body.solanaMode, "mock");
  assert.equal(response.body.database.badges.merchant, 1);
  assert.equal(response.body.database.badges.customer, 1);
  assert.deepEqual(response.body.database.migrations.map((migration) => migration.version), [1, 2, 3, 4, 5, 6]);
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(f.customer.secretKey.slice(0, 12)), false);
  assert.equal(serialized.includes(f.customer.publicKey), false);
});

test("admin can create and list badge-to-address mappings", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const merchantAddress = f.solana.generateWallet().publicKey;
  const created = await request(f.app).post("/api/admin/badges").set("x-admin-key", "admin-secret")
    .send({ badgeId: "SHOP-002", role: "merchant", solanaAddress: merchantAddress }).expect(201);
  assert.equal(created.body.publicKey, merchantAddress);
  assert.equal(created.body.secretKey, undefined);
  const payer = await request(f.app).post("/api/admin/badges").set("x-admin-key", "admin-secret")
    .send({ badgeId: "PAY-002", role: "customer" }).expect(201);
  assert.ok(payer.body.publicKey);
  const listed = await request(f.app).get("/api/admin/badges").set("x-admin-key", "admin-secret").expect(200);
  assert.ok(listed.body.badges.some((badge) => badge.badgeId === "SHOP-002" && badge.solanaAddress === merchantAddress));
  assert.ok(listed.body.badges.some((badge) => badge.badgeId === "PAY-002"));
  const balance = await request(f.app).get("/api/admin/badges/PAY-002/balance").set("x-admin-key", "admin-secret").expect(200);
  assert.equal(balance.body.role, "customer");
  assert.equal(balance.body.lamports, 10_000_000_000);
});

test("badge registrations mirror public mappings to Supabase and support backfill", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const mirrored = [];
  const registry = {
    async upsertBadge(profile) { mirrored.push(profile); return { status: "synced", table: "badge_wallets" }; },
    async syncBadges(badges) { mirrored.push(...badges); return { status: "synced", table: "badge_wallets", count: badges.length }; },
  };
  const config = { apiKeys: new Map([["laptop-secret", "laptop-1"]]), adminApiKey: "admin-secret", solanaMode: "mock", intentTtlSeconds: 90, supabaseTable: "badge_wallets" };
  const app = createApp({ config, store: f.store, solana: f.solana, registry });
  const created = await request(app).post("/api/badges").set(auth).send({ role: "customer", badgeId: "lilac-hickory-atlas-west" }).expect(201);
  assert.equal(created.body.registrySync.status, "synced");
  assert.equal(mirrored[0].badgeId, created.body.badgeId);
  assert.equal("secretKey" in mirrored[0], false);
  const backfill = await request(app).post("/api/admin/supabase/sync").set("x-admin-key", "admin-secret").expect(200);
  assert.equal(backfill.body.count, f.store.listBadges().length);
});

test("complete payment signs on backend and confirms through laptop submit", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const created = await request(f.app).post("/api/intents").set(auth).send({ terminalBadgeId: "TERM-001", amountLamports: 25_000_000, memo: "Lunch" }).expect(201);
  assert.equal(created.body.status, "pending");
  assert.ok(created.body.radioPacket.startsWith("SP1:I:"));
  assert.equal(created.body.protocolVersion, 1);
  assert.match(created.body.intentNonce, /^[A-Za-z0-9_-]{11}$/);
  const approved = await request(f.app).post(`/api/intents/${created.body.id}/approve`).set(auth).send({ customerBadgeId: "CUST-001", intentNonce: created.body.intentNonce }).expect(200);
  assert.ok(approved.body.signedTransaction.rawTransaction);
  const submitted = await request(f.app).post(`/api/intents/${created.body.id}/submit`).set(auth).send({ signedTransaction: approved.body.signedTransaction }).expect(200);
  assert.equal(submitted.body.intent.status, "confirmed");
  assert.equal(f.solana.balances.get(f.merchant.publicKey), 25_000_000);
  const history = await request(f.app).get("/api/transactions").set(auth).expect(200);
  assert.equal(history.body.transactions[0].id, created.body.id);
  assert.equal(history.body.transactions[0].status, "confirmed");
  assert.equal(history.body.transactions[0].signature, submitted.body.intent.signature);
  assert.equal(history.body.transactions[0].explorerUrl, undefined);
});

test("real clusters expose Solana Explorer links", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const app = createApp({
    store: f.store,
    solana: f.solana,
    config: { apiKeys: new Map([["laptop-secret", "laptop-1"]]), adminApiKey: "admin-secret", solanaMode: "testnet", intentTtlSeconds: 90 },
  });
  const balance = await request(app).get("/api/badges/TERM-001/balance").set(auth).expect(200);
  assert.equal(balance.body.cluster, "testnet");
  assert.match(balance.body.explorerUrl, /^https:\/\/explorer\.solana\.com\/address\/.+\?cluster=testnet$/);
});

test("duplicate approvals and invalid intent nonces are rejected", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const first = await request(f.app).post("/api/intents").set(auth).send({ terminalBadgeId: "TERM-001", amountLamports: 1 }).expect(201);
  await request(f.app).post(`/api/intents/${first.body.id}/approve`).set(auth).send({ customerBadgeId: "CUST-001", intentNonce: first.body.intentNonce }).expect(200);
  const duplicate = await request(f.app).post(`/api/intents/${first.body.id}/approve`).set(auth).send({ customerBadgeId: "CUST-001", intentNonce: first.body.intentNonce }).expect(409);
  assert.equal(duplicate.body.code, "INTENT_ALREADY_USED");
  const second = await request(f.app).post("/api/intents").set(auth).send({ terminalBadgeId: "TERM-001", amountLamports: 1 }).expect(201);
  const invalid = await request(f.app).post(`/api/intents/${second.body.id}/approve`).set(auth).send({ customerBadgeId: "CUST-001", intentNonce: first.body.intentNonce }).expect(409);
  assert.equal(invalid.body.code, "INVALID_NONCE");
});

test("a registered payer must have enough SOL before an intent can be claimed", async (t) => {
  const f = fixture(); t.after(() => f.store.close());
  const created = await request(f.app).post("/api/intents").set(auth)
    .send({ terminalBadgeId: "TERM-001", amountLamports: 2_000_000_000 }).expect(201);
  const rejected = await request(f.app).post(`/api/intents/${created.body.id}/approve`).set(auth)
    .send({ customerBadgeId: "CUST-001", intentNonce: created.body.intentNonce }).expect(422);
  assert.equal(rejected.body.code, "INSUFFICIENT_FUNDS");
  assert.equal(rejected.body.availableLamports, 2_000_000_000);
  assert.ok(rejected.body.requiredLamports > rejected.body.availableLamports);
});

test("expired intents, unauthorized access, and transaction replacement are rejected", async (t) => {
  const f = fixture(-1); t.after(() => f.store.close());
  await request(f.app).post("/api/intents").send({ terminalBadgeId: "TERM-001", amountLamports: 1 }).expect(401);
  const expired = await request(f.app).post("/api/intents").set(auth).send({ terminalBadgeId: "TERM-001", amountLamports: 1 }).expect(201);
  const response = await request(f.app).post(`/api/intents/${expired.body.id}/approve`).set(auth).send({ customerBadgeId: "CUST-001", intentNonce: expired.body.intentNonce }).expect(409);
  assert.equal(response.body.code, "INTENT_EXPIRED");

  const live = fixture(); t.after(() => live.store.close());
  const created = await request(live.app).post("/api/intents").set(auth).send({ terminalBadgeId: "TERM-001", amountLamports: 1 }).expect(201);
  await request(live.app).post(`/api/intents/${created.body.id}/approve`).set("authorization", "Bearer other-secret").send({ customerBadgeId: "CUST-001", intentNonce: created.body.intentNonce }).expect(403);
  const approved = await request(live.app).post(`/api/intents/${created.body.id}/approve`).set(auth).send({ customerBadgeId: "CUST-001", intentNonce: created.body.intentNonce }).expect(200);
  const changed = { ...approved.body.signedTransaction, rawTransaction: Buffer.from("evil").toString("base64") };
  const mismatch = await request(live.app).post(`/api/intents/${created.body.id}/submit`).set(auth).send({ signedTransaction: changed }).expect(422);
  assert.equal(mismatch.body.code, "TRANSACTION_MISMATCH");
});

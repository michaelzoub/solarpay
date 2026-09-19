import express from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adminAuth, laptopAuth } from "./auth.js";
import { encodeLvglIcon, encodeLvglQr, encodeLvglSolanaLogo } from "./badge-assets.js";
import { readBadgeApp } from "./badge-source.js";
import { intentItemPacket, intentPacket } from "./protocol.js";

const badgeId = z.string().regex(/^[A-Za-z0-9_-]{1,63}$/);
const nonce = z.string().regex(/^[A-Za-z0-9_-]{8,16}$/);

export function createApp({ config, store, solana, registry = null }) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true, solanaMode: config.solanaMode, cluster: config.solanaMode, supabaseConfigured: Boolean(registry) }));
  app.get("/api/badge-apps/solarpay-bundle", asyncRoute(async (req, res) => {
    const role = req.query.role === "merchant" ? "merchant" : "customer";
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../badges");
    const source = readBadgeApp(path.join(directory, `solarpay_${role}.lua`));
    res.json({ role, source, files: [{ path: "icon.bin", data: encodeLvglIcon(role).toString("base64") }, { path: "solana.bin", data: encodeLvglSolanaLogo().toString("base64") }] });
  }));
  app.get("/api/badge-apps/:role", (req, res) => {
    const filename = req.params.role === "merchant" ? "terminal.lua"
      : req.params.role === "customer" ? "customer.lua"
        : req.params.role === "tap" ? "tap_logger.lua"
          : req.params.role === "solarpay" && req.query.role === "merchant" ? "solarpay_merchant.lua"
            : req.params.role === "solarpay" ? "solarpay_customer.lua"
          : null;
    if (!filename) return res.status(404).json({ error: "Badge app was not found", code: "APP_NOT_FOUND" });
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../badges");
    // Served expanded, so a download is a runnable app rather than a source
    // file with an unresolved --#include in it.
    res.type("text/plain").attachment(`solarpay-${req.params.role}.lua`)
      .send(readBadgeApp(path.join(directory, filename)));
  });

  app.post("/api/admin/badges", adminAuth(config.adminApiKey), asyncRoute(async (req, res) => {
    const body = z.object({ badgeId, role: z.enum(["merchant", "customer"]), solanaAddress: z.string().trim().optional() }).parse(req.body);
    let wallet;
    if (body.role === "merchant" && body.solanaAddress) {
      try { wallet = { publicKey: new PublicKey(body.solanaAddress).toBase58(), secretKey: null }; }
      catch { return res.status(400).json({ error: "Merchant Solana address is invalid", code: "INVALID_SOLANA_ADDRESS" }); }
    } else {
      wallet = solana.generateWallet();
    }
    if (config.solanaMode === "mock" && body.role === "customer" && solana.fund) solana.fund(wallet.publicKey, 10_000_000_000);
    const profile = store.registerBadge({ ...body, ...wallet });
    const registrySync = await mirrorBadge(registry, profile);
    res.status(201).json({ ...publicBadge(profile), registrySync });
  }));

  app.get("/api/admin/badges", adminAuth(config.adminApiKey), (_req, res) => {
    res.json({ badges: store.listBadges() });
  });

  app.post("/api/admin/supabase/sync", adminAuth(config.adminApiKey), asyncRoute(async (_req, res) => {
    if (!registry) return res.status(503).json({ error: "Supabase is not configured", code: "SUPABASE_NOT_CONFIGURED" });
    res.json(await registry.syncBadges(store.listBadges()));
  }));

  app.get("/api/admin/badges/:badgeId/balance", adminAuth(config.adminApiKey), asyncRoute(async (req, res) => {
    const wallet = store.walletFor(req.params.badgeId);
    if (!wallet) return res.status(404).json({ error: "Registered badge was not found", code: "BADGE_NOT_FOUND" });
    const lamports = await solana.getBalance(wallet.publicKey);
    res.json({ badgeId: wallet.badgeId, role: wallet.role, solanaAddress: wallet.publicKey, lamports, sol: lamports / 1_000_000_000 });
  }));

  app.use("/api", laptopAuth(config.apiKeys));

  app.post("/api/badges", asyncRoute(async (req, res) => {
    const body = z.object({ badgeId, role: z.enum(["merchant", "customer"]) }).parse(req.body);
    // One laptop may own a customer badge AND a merchant badge, so that a real
    // two-badge payment works. Scoping only by owner meant registering a second
    // badge renamed the first instead of adding it, and the badge that lost its
    // row then failed approval with CUSTOMER_NOT_FOUND.
    //
    // Three cases, in order:
    //   1. this exact badge is already ours -> reuse it, whatever role it was
    //      first registered under (one physical badge can act as both);
    //   2. we already own a badge in this role -> this is a replacement for it;
    //   3. otherwise -> a new badge for this role.
    const existing = store.walletFor(body.badgeId);
    if (existing && existing.ownerId && existing.ownerId !== req.laptopId) {
      return res.status(409).json({ error: "This physical badge ID is already registered", code: "BADGE_ALREADY_REGISTERED" });
    }

    let profile = existing && existing.ownerId === req.laptopId ? existing : null;
    let created = false;
    if (!profile) {
      const sameRole = store.walletForOwner(req.laptopId, body.role);
      if (sameRole) {
        profile = store.reassignBadgeIdForOwner(req.laptopId, body.badgeId, body.role);
      } else {
        if (existing) return res.status(409).json({ error: "This physical badge ID is already registered", code: "BADGE_ALREADY_REGISTERED" });
        const wallet = solana.generateWallet();
        profile = store.registerBadge({ ...body, ownerId: req.laptopId, ...wallet });
        created = true;
      }
    }
    const registrySync = await mirrorBadge(registry, profile);
    let funding;
    if (created && body.role === "customer") {
      try { funding = { status: "confirmed", ...await solana.airdrop(profile.publicKey, config.payerAirdropLamports ?? 2_000_000_000) }; }
      catch (error) { funding = { status: "failed", error: error.message || "Faucet request failed" }; }
    }
    res.status(created ? 201 : 200).json({ ...publicBadge(profile), funding, cluster: config.solanaMode, registrySync, reused: !created });
  }));

  app.post("/api/badges/:badgeId/airdrop", asyncRoute(async (req, res) => {
    const wallet = store.walletFor(req.params.badgeId, "customer");
    if (!wallet) return res.status(404).json({ error: "Registered sender badge was not found", code: "BADGE_NOT_FOUND" });
    const funding = await solana.airdrop(wallet.publicKey, config.payerAirdropLamports ?? 2_000_000_000);
    const balance = await solana.getBalance(wallet.publicKey);
    res.json({ badgeId: wallet.badgeId, funding: { status: "confirmed", ...funding }, lamports: balance, sol: balance / 1_000_000_000, cluster: config.solanaMode });
  }));

  app.get("/api/badges", (req, res) => res.json({ badges: store.listBadges(req.laptopId).map(publicBadge) }));

  app.get("/api/badges/:badgeId/balance", asyncRoute(async (req, res) => {
    const wallet = store.walletFor(req.params.badgeId);
    if (!wallet) return res.status(404).json({ error: "Registered badge was not found", code: "BADGE_NOT_FOUND" });
    const lamports = await solana.getBalance(wallet.publicKey);
    res.json({ badgeId: wallet.badgeId, role: wallet.role, solanaAddress: wallet.publicKey, lamports, sol: lamports / 1_000_000_000, cluster: config.solanaMode, explorerUrl: explorerAddressUrl(wallet.publicKey, config.solanaMode) });
  }));

  app.get("/api/badges/:badgeId/app", asyncRoute(async (req, res) => {
    const wallet = store.walletFor(req.params.badgeId);
    if (!wallet) return res.status(404).json({ error: "Registered badge was not found", code: "BADGE_NOT_FOUND" });
    const filename = wallet.role === "merchant" ? "terminal.lua" : "customer.lua";
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../badges");
    const source = readBadgeApp(path.join(directory, filename));
    const personalized = source.replaceAll("__SOLARPAY_BADGE_ID__", wallet.badgeId).replaceAll("__SOLARPAY_WALLET_ADDRESS__", wallet.publicKey);
    res.set("content-type", "text/x-lua; charset=utf-8");
    res.set("content-disposition", `attachment; filename="solarpay-${wallet.role}-${wallet.badgeId}.lua"`);
    res.send(personalized);
  }));

  app.get("/api/badges/:badgeId/solarpay-app", asyncRoute(async (req, res) => {
    const wallet = store.walletFor(req.params.badgeId);
    if (!wallet) return res.status(404).json({ error: "Registered badge was not found", code: "BADGE_NOT_FOUND" });
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../badges");
    // readBadgeApp, not readFile: the solarpay apps carry a `--#include
    // lib/splink.lua` directive. Served raw, that line stays a Lua comment and
    // the installed main.lua faults on the first `splink.` access.
    const source = readBadgeApp(path.join(directory, `solarpay_${wallet.role}.lua`));
    const lamports = await solana.getBalance(wallet.publicKey);
    const personalized = source
      .replaceAll("__SOLARPAY_BADGE_ID__", wallet.badgeId)
      .replaceAll("__SOLARPAY_WALLET_ADDRESS__", wallet.publicKey)
      .replaceAll("__SOLARPAY_BALANCE__", (lamports / 1_000_000_000).toFixed(4))
      .replaceAll("__SOLARPAY_QR_AVAILABLE__", "0");
    res.set("content-type", "text/x-lua; charset=utf-8");
    res.set("content-disposition", `attachment; filename="solarpay-${wallet.badgeId}.lua"`);
    res.send(personalized);
  }));

  app.get("/api/badges/:badgeId/solarpay-bundle", asyncRoute(async (req, res) => {
    const wallet = store.walletFor(req.params.badgeId);
    if (!wallet) return res.status(404).json({ error: "Registered badge was not found", code: "BADGE_NOT_FOUND" });
    const appRole = req.query.role === "merchant" ? "merchant" : req.query.role === "customer" ? "customer" : wallet.role;
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../badges");
    const source = readBadgeApp(path.join(directory, `solarpay_${appRole}.lua`));
    const lamports = await solana.getBalance(wallet.publicKey);
    const includeQr = appRole === "customer";
    const personalized = source
      .replaceAll("__SOLARPAY_BADGE_ID__", wallet.badgeId)
      .replaceAll("__SOLARPAY_WALLET_ADDRESS__", wallet.publicKey)
      .replaceAll("__SOLARPAY_BALANCE__", (lamports / 1_000_000_000).toFixed(4))
      .replaceAll("__SOLARPAY_QR_AVAILABLE__", includeQr ? "1" : "0");
    const files = [{ path: "icon.bin", data: encodeLvglIcon(appRole).toString("base64") }];
    if (includeQr) files.push({ path: "qr.bin", data: encodeLvglQr(`solarpay:${wallet.badgeId}`).toString("base64") });
    files.push({ path: "solana.bin", data: encodeLvglSolanaLogo().toString("base64") });
    res.json({ role: appRole, source: personalized, files });
  }));

  app.get("/api/diagnostics", (_req, res) => {
    res.json({
      capturedAt: new Date().toISOString(),
      appVersion: "0.1.0",
      solanaMode: config.solanaMode,
      intentTtlSeconds: config.intentTtlSeconds,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      database: store.diagnostics(),
      supabase: { configured: Boolean(registry), table: config.supabaseTable },
      security: { walletEncryptionConfigured: !["", "development-only-encryption-key"].includes(config.encryptionKey) },
    });
  });

  app.post("/api/intents", asyncRoute(async (req, res) => {
    const body = z.object({ terminalBadgeId: badgeId, amountLamports: z.number().int().positive().max(10_000_000_000), memo: z.string().max(64).default("") }).parse(req.body);
    const merchant = store.walletFor(body.terminalBadgeId, "merchant");
    if (!merchant) return res.status(404).json({ error: "Authorized merchant badge was not found", code: "MERCHANT_NOT_FOUND" });
    const id = randomBytes(4).toString("hex");
    const intentNonce = randomBytes(8).toString("base64url");
    const expiresAt = Date.now() + config.intentTtlSeconds * 1000;
    const intent = store.createIntent({ id, terminalBadgeId: body.terminalBadgeId, merchantAddress: merchant.publicKey, amountLamports: body.amountLamports, memo: body.memo, expiresAt, intentNonce, protocolVersion: 1, createdBy: req.laptopId });
    res.status(201).json({
      ...publicIntent(intent, config.solanaMode),
      radioPacket: intentPacket(intent, config.intentTtlSeconds, body.terminalBadgeId),
      radioItemPacket: intentItemPacket(intent, body.memo),
    });
  }));

  app.post("/api/intents/:id/approve", asyncRoute(async (req, res) => {
    const body = z.object({ customerBadgeId: badgeId, intentNonce: nonce }).parse(req.body);
    const customer = store.walletForReference(body.customerBadgeId);
    if (!customer) return res.status(404).json({ error: "Authorized customer badge was not found", code: "CUSTOMER_NOT_FOUND" });
    const existing = store.getIntent(req.params.id);
    if (!existing) return res.status(404).json({ error: "Payment intent was not found", code: "INTENT_NOT_FOUND" });
    if (existing.created_by !== req.laptopId) return res.status(403).json({ error: "Intent belongs to another laptop session", code: "INTENT_OWNER_MISMATCH" });
    const available = await solana.getBalance(customer.publicKey);
    const required = existing.amount_lamports + (config.feeReserveLamports ?? 5_000);
    if (available < required) return res.status(422).json({
      error: "Payer wallet does not have enough SOL for the amount and network fee",
      code: "INSUFFICIENT_FUNDS",
      availableLamports: available,
      requiredLamports: required,
    });
    const claimed = store.claimApproval({ id: req.params.id, customerBadgeId: customer.badgeId, intentNonce: body.intentNonce, now: Date.now() });
    try {
      const signed = await solana.signTransfer({ fromWallet: customer, toAddress: claimed.merchant_address, amountLamports: claimed.amount_lamports, intentId: claimed.id });
      store.bindSignedPayload(claimed.id, transactionHash(signed.rawTransaction));
      res.json({ intent: publicIntent(claimed, config.solanaMode), signedTransaction: signed });
    } catch (error) {
      store.setSubmission(claimed.id, "failed");
      throw error;
    }
  }));

  app.post("/api/intents/:id/cancel", (req, res) => {
    res.json({ intent: publicIntent(store.cancelIntent(req.params.id, req.laptopId), config.solanaMode) });
  });

  app.post("/api/intents/:id/submit", asyncRoute(async (req, res) => {
    const body = z.object({ signedTransaction: z.object({ rawTransaction: z.string(), signature: z.string(), blockhash: z.string(), lastValidBlockHeight: z.number() }) }).parse(req.body);
    const intent = store.getIntent(req.params.id);
    if (!intent) return res.status(404).json({ error: "Payment intent was not found", code: "INTENT_NOT_FOUND" });
    if (intent.created_by !== req.laptopId) return res.status(403).json({ error: "Intent belongs to another laptop session", code: "INTENT_OWNER_MISMATCH" });
    if (intent.status !== "signed") return res.status(409).json({ error: "Payment is not ready for submission", code: "INVALID_STATE" });
    if (!intent.signed_payload_hash || intent.signed_payload_hash !== transactionHash(body.signedTransaction.rawTransaction)) {
      return res.status(422).json({ error: "Submitted transaction does not match the backend-signed payment", code: "TRANSACTION_MISMATCH" });
    }
    store.setSubmission(intent.id, "submitted");
    try {
      const signature = await solana.submitAndConfirm(body.signedTransaction);
      res.json({ intent: publicIntent(store.setSubmission(intent.id, "confirmed", signature), config.solanaMode) });
    } catch (error) {
      store.setSubmission(intent.id, "failed");
      throw error;
    }
  }));

  app.get("/api/intents/:id", (req, res) => {
    const intent = store.getIntent(req.params.id);
    if (!intent || intent.created_by !== req.laptopId) return res.status(404).json({ error: "Payment intent was not found", code: "INTENT_NOT_FOUND" });
    res.json({ intent: publicIntent(intent, config.solanaMode) });
  });

  app.get("/api/transactions", (req, res) => {
    const transactions = store.listIntents(req.laptopId, 20).map((intent) => publicIntent(intent, config.solanaMode));
    res.json({ transactions, cluster: config.solanaMode });
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", code: "VALIDATION_ERROR", details: error.issues });
    if (!error.status || error.status >= 500) console.error(error);
    const recovery = error.faucetUrl ? { faucetUrl: error.faucetUrl, recipientAddress: error.recipientAddress } : undefined;
    res.status(error.status || 500).json({ error: error.message || "Internal server error", code: error.code || "INTERNAL_ERROR", recovery });
  });
  return app;
}

function publicIntent(row, cluster) {
  return {
    id: row.id, terminalBadgeId: row.terminal_badge_id, merchantAddress: row.merchant_address,
    amountLamports: row.amount_lamports, memo: row.memo, expiresAt: row.expires_at,
    intentNonce: row.intent_nonce, protocolVersion: row.protocol_version, status: row.status,
    customerBadgeId: row.customer_badge_id || undefined, signature: row.signature || undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
    explorerUrl: row.signature ? explorerTransactionUrl(row.signature, cluster) : undefined,
  };
}

function explorerTransactionUrl(signature, cluster) {
  if (!signature || cluster === "mock") return undefined;
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${encodeURIComponent(cluster)}`;
}

function explorerAddressUrl(address, cluster) {
  if (!address || cluster === "mock") return undefined;
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=${encodeURIComponent(cluster)}`;
}

function publicBadge(profile) {
  const { ownerId: _ownerId, secretKey: _secretKey, ...publicProfile } = profile;
  return publicProfile;
}

function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next); }

async function mirrorBadge(registry, profile) {
  if (!registry) return { status: "disabled" };
  try { return await registry.upsertBadge(profile); }
  catch (error) { return { status: "failed", code: error.code || "SUPABASE_SYNC_FAILED", error: error.message }; }
}

function transactionHash(rawTransaction) { return createHash("sha256").update(rawTransaction).digest("hex"); }

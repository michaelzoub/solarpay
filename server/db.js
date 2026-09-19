import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decryptJson, encryptJson } from "./crypto.js";

export class Store {
  constructor(filename, encryptionKey) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.key = encryptionKey;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (const [version, filename] of [[1, "001_initial.sql"], [2, "002_intent_protocol.sql"], [3, "003_badge_owner.sql"], [4, "004_long_badge_ids.sql"], [5, "005_cancelled_intents.sql"]]) {
      const applied = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
      if (!applied) {
        const sql = readFileSync(new URL(`../migrations/${filename}`, import.meta.url), "utf8");
        if (version === 4) this.db.pragma("foreign_keys = OFF");
        try {
          this.db.transaction(() => {
            this.db.exec(sql);
            this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
          })();
        } finally {
          if (version === 4) this.db.pragma("foreign_keys = ON");
        }
      }
    }
  }

  registerBadge({ badgeId, role, publicKey, secretKey, ownerId = null }) {
    const wallet = encryptJson({ publicKey, secretKey }, this.key);
    const now = Date.now();
    this.db.prepare(`INSERT INTO badges (badge_id, role, wallet_ciphertext, owner_id, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(badge_id) DO UPDATE SET role=excluded.role,
      wallet_ciphertext=excluded.wallet_ciphertext, owner_id=COALESCE(excluded.owner_id, badges.owner_id), enabled=1`)
      .run(badgeId, role, wallet, ownerId, now);
    return this.badgeProfile(this.db.prepare("SELECT * FROM badges WHERE badge_id = ?").get(badgeId), false);
  }

  walletForOwner(ownerId) {
    if (!ownerId) return null;
    return this.badgeProfile(this.db.prepare("SELECT * FROM badges WHERE owner_id = ? AND enabled = 1").get(ownerId), false);
  }

  reassignBadgeIdForOwner(ownerId, badgeId) {
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT * FROM badges WHERE owner_id = ? AND enabled = 1").get(ownerId);
      if (!current) return null;
      if (current.badge_id === badgeId) return this.badgeProfile(current, false);
      const claimed = this.db.prepare("SELECT owner_id FROM badges WHERE badge_id = ?").get(badgeId);
      if (claimed) throw conflict("This physical badge ID is already registered", "BADGE_ALREADY_REGISTERED");
      this.db.prepare("UPDATE badges SET owner_id = NULL WHERE badge_id = ?").run(current.badge_id);
      this.db.prepare(`INSERT INTO badges (badge_id, role, wallet_ciphertext, enabled, created_at, owner_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(badgeId, current.role, current.wallet_ciphertext, current.enabled, current.created_at, ownerId);
      this.db.prepare("UPDATE payment_intents SET terminal_badge_id = ? WHERE terminal_badge_id = ?").run(badgeId, current.badge_id);
      this.db.prepare("UPDATE payment_intents SET customer_badge_id = ? WHERE customer_badge_id = ?").run(badgeId, current.badge_id);
      this.db.prepare("DELETE FROM badges WHERE badge_id = ?").run(current.badge_id);
      return this.badgeProfile(this.db.prepare("SELECT * FROM badges WHERE badge_id = ?").get(badgeId), false);
    })();
  }

  walletFor(badgeId, requiredRole) {
    const row = this.db.prepare("SELECT * FROM badges WHERE badge_id = ? AND enabled = 1").get(badgeId);
    if (!row) return null;
    return this.badgeProfile(row);
  }

  walletForReference(reference) {
    const exact = this.walletFor(reference);
    if (exact) return exact;
    const rows = this.db.prepare(`SELECT * FROM badges
      WHERE enabled = 1 AND substr(badge_id, 1, length(?)) = ? LIMIT 2`).all(reference, reference);
    return rows.length === 1 ? this.badgeProfile(rows[0]) : null;
  }

  listBadges(ownerId = null) {
    const rows = ownerId
      ? this.db.prepare("SELECT badge_id, role, wallet_ciphertext, owner_id, enabled, created_at FROM badges WHERE owner_id = ? ORDER BY created_at DESC").all(ownerId)
      : this.db.prepare("SELECT badge_id, role, wallet_ciphertext, owner_id, enabled, created_at FROM badges ORDER BY created_at DESC").all();
    return rows
      .map((row) => {
        const wallet = decryptJson(row.wallet_ciphertext, this.key);
        return { badgeId: row.badge_id, role: row.role, roles: ["customer", "merchant"], solanaAddress: wallet.publicKey, ownerId: row.owner_id || undefined, enabled: Boolean(row.enabled), createdAt: row.created_at };
      });
  }

  badgeProfile(row, includeSecret = true) {
    if (!row) return null;
    const wallet = decryptJson(row.wallet_ciphertext, this.key);
    return {
      badgeId: row.badge_id,
      role: row.role,
      roles: ["customer", "merchant"],
      ownerId: row.owner_id || undefined,
      createdAt: row.created_at,
      publicKey: wallet.publicKey,
      ...(includeSecret ? { secretKey: wallet.secretKey } : {}),
    };
  }

  diagnostics() {
    const migrations = this.db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
    const badgeCounts = this.db.prepare("SELECT role, COUNT(*) AS count FROM badges WHERE enabled = 1 GROUP BY role").all();
    const paymentCounts = this.db.prepare("SELECT status, COUNT(*) AS count FROM payment_intents GROUP BY status").all();
    return {
      migrations,
      badges: Object.fromEntries(badgeCounts.map((row) => [row.role, row.count])),
      payments: Object.fromEntries(paymentCounts.map((row) => [row.status, row.count])),
    };
  }

  createIntent(intent) {
    this.db.prepare(`INSERT INTO payment_intents
      (id, terminal_badge_id, merchant_address, amount_lamports, memo, expires_at, intent_nonce, protocol_version, status, created_by, created_at, updated_at)
      VALUES (@id, @terminalBadgeId, @merchantAddress, @amountLamports, @memo, @expiresAt, @intentNonce, @protocolVersion, 'pending', @createdBy, @now, @now)`)
      .run({ ...intent, now: Date.now() });
    return this.getIntent(intent.id);
  }

  getIntent(id) {
    return this.db.prepare("SELECT * FROM payment_intents WHERE id = ?").get(id);
  }

  listIntents(createdBy, limit = 20) {
    return this.db.prepare(`SELECT * FROM payment_intents WHERE created_by = ?
      ORDER BY created_at DESC LIMIT ?`).all(createdBy, limit);
  }

  claimApproval({ id, customerBadgeId, intentNonce, now }) {
    return this.db.transaction(() => {
      const row = this.getIntent(id);
      if (!row) throw conflict("Payment intent was not found", "INTENT_NOT_FOUND", 404);
      if (row.status !== "pending") throw conflict("Payment intent has already been used", "INTENT_ALREADY_USED");
      if (!row.intent_nonce || row.intent_nonce !== intentNonce) throw conflict("Payment intent nonce is invalid", "INVALID_NONCE");
      if (row.expires_at <= now) {
        this.db.prepare("UPDATE payment_intents SET status='expired', updated_at=? WHERE id=?").run(now, id);
        throw conflict("Payment intent has expired", "INTENT_EXPIRED");
      }
      try {
        this.db.prepare(`UPDATE payment_intents SET status='signed', customer_badge_id=?, customer_nonce=?, updated_at=?
          WHERE id=? AND status='pending'`).run(customerBadgeId, intentNonce, now, id);
      } catch (error) {
        if (String(error.message).includes("UNIQUE")) throw conflict("Approval nonce has already been used", "NONCE_REUSED");
        throw error;
      }
      return this.getIntent(id);
    })();
  }

  bindSignedPayload(id, hash) {
    this.db.prepare("UPDATE payment_intents SET signed_payload_hash=?, updated_at=? WHERE id=? AND status='signed'")
      .run(hash, Date.now(), id);
  }

  cancelIntent(id, createdBy) {
    return this.db.transaction(() => {
      const row = this.getIntent(id);
      if (!row || row.created_by !== createdBy) throw conflict("Payment intent was not found", "INTENT_NOT_FOUND", 404);
      if (row.status !== "pending") throw conflict("Payment can no longer be cancelled", "INVALID_STATE");
      this.db.prepare("UPDATE payment_intents SET status='cancelled', updated_at=? WHERE id=? AND status='pending'")
        .run(Date.now(), id);
      return this.getIntent(id);
    })();
  }

  setSubmission(id, status, signature) {
    this.db.prepare("UPDATE payment_intents SET status=?, signature=COALESCE(?, signature), updated_at=? WHERE id=?")
      .run(status, signature || null, Date.now(), id);
    return this.getIntent(id);
  }

  close() { this.db.close(); }
}

function conflict(message, code, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

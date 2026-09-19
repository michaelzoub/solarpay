import { createClient } from "@supabase/supabase-js";

export function createSupabaseRegistry(config) {
  const hasUrl = Boolean(config.supabaseUrl);
  const hasKey = Boolean(config.supabaseSecretKey);
  if (!hasUrl && !hasKey) return null;
  if (!hasUrl || !hasKey) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be configured together");

  const client = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return new SupabaseRegistry(client, config.supabaseTable);
}

export class SupabaseRegistry {
  constructor(client, table = "badge_wallets") {
    this.client = client;
    this.table = table;
  }

  async upsertBadge(badge) {
    const row = toRow(badge);
    const onConflict = badge.ownerId ? "owner_id" : "badge_id";
    let { error } = await this.client.from(this.table).upsert(row, { onConflict });
    let compatibility;
    if (isMissingOwnerId(error)) {
      ({ error } = await this.client.from(this.table).upsert(withoutOwnerId(row), { onConflict: "badge_id" }));
      compatibility = "legacy-schema";
    }
    if (error) throw supabaseError(error);
    return { status: "synced", table: this.table, ...(compatibility ? { compatibility } : {}) };
  }

  async syncBadges(badges) {
    if (!badges.length) return { status: "synced", table: this.table, count: 0 };
    const owned = badges.filter((badge) => badge.ownerId);
    const unowned = badges.filter((badge) => !badge.ownerId);
    for (const [group, onConflict] of [[owned, "owner_id"], [unowned, "badge_id"]]) {
      if (!group.length) continue;
      const rows = group.map(toRow);
      let { error } = await this.client.from(this.table).upsert(rows, { onConflict });
      if (isMissingOwnerId(error)) {
        ({ error } = await this.client.from(this.table).upsert(rows.map(withoutOwnerId), { onConflict: "badge_id" }));
      }
      if (error) throw supabaseError(error);
    }
    return { status: "synced", table: this.table, count: badges.length };
  }
}

function withoutOwnerId({ owner_id: _ownerId, ...row }) {
  return row;
}

function isMissingOwnerId(error) {
  if (!error) return false;
  const description = [error.message, error.details, error.hint].filter(Boolean).join(" ").toLowerCase();
  return description.includes("owner_id") && ["42703", "42P10", "PGRST204"].includes(error.code);
}

function toRow(badge) {
  const address = badge.solanaAddress || badge.publicKey;
  return {
    badge_id: badge.badgeId,
    owner_id: badge.ownerId || null,
    role: badge.role,
    solana_address: address,
    enabled: badge.enabled ?? true,
    created_at: badge.createdAt ? new Date(badge.createdAt).toISOString() : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function supabaseError(error) {
  return Object.assign(new Error(`Supabase registry sync failed: ${error.message}`), {
    code: "SUPABASE_SYNC_FAILED",
    status: 502,
    details: error.details,
  });
}

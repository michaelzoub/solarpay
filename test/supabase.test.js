import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseRegistry, createSupabaseRegistry } from "../server/supabase.js";

test("Supabase registry upserts only public badge mapping fields", async () => {
  const calls = [];
  const client = {
    from(table) {
      return { upsert: async (rows, options) => { calls.push({ table, rows, options }); return { error: null }; } };
    },
  };
  const registry = new SupabaseRegistry(client, "badge_wallets");
  await registry.upsertBadge({ badgeId: "PAY-001", role: "customer", publicKey: "public-address", secretKey: "must-not-leak", createdAt: 1_700_000_000_000 });
  assert.equal(calls[0].table, "badge_wallets");
  assert.equal(calls[0].options.onConflict, "badge_id");
  assert.equal(calls[0].rows.badge_id, "PAY-001");
  assert.equal(calls[0].rows.solana_address, "public-address");
  assert.equal(JSON.stringify(calls[0]).includes("must-not-leak"), false);
});

test("Supabase registry uses the stable owner identity for repeat setups", async () => {
  const calls = [];
  const client = {
    from(table) {
      return { upsert: async (rows, options) => { calls.push({ table, rows, options }); return { error: null }; } };
    },
  };
  const registry = new SupabaseRegistry(client, "badge_wallets");
  await registry.upsertBadge({ badgeId: "PAY-001", ownerId: "user-1", role: "customer", publicKey: "public-address" });
  assert.equal(calls[0].options.onConflict, "owner_id");
  assert.equal(calls[0].rows.owner_id, "user-1");
});

test("Supabase registry falls back to the deployed legacy schema when owner_id is missing", async () => {
  const calls = [];
  const client = {
    from(table) {
      return {
        upsert: async (rows, options) => {
          calls.push({ table, rows, options });
          return calls.length === 1
            ? { error: { code: "42703", message: "column badge_wallets.owner_id does not exist" } }
            : { error: null };
        },
      };
    },
  };
  const registry = new SupabaseRegistry(client, "badge_wallets");
  const result = await registry.upsertBadge({ badgeId: "PAY-001", ownerId: "user-1", role: "customer", publicKey: "public-address" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.onConflict, "badge_id");
  assert.equal("owner_id" in calls[1].rows, false);
  assert.equal(result.compatibility, "legacy-schema");
});

test("Supabase registry omits a null owner_id for unowned badges on the legacy schema", async () => {
  const calls = [];
  const client = {
    from(table) {
      return {
        upsert: async (rows, options) => {
          calls.push({ table, rows, options });
          return calls.length === 1
            ? { error: { code: "PGRST204", message: "Could not find the 'owner_id' column in the schema cache" } }
            : { error: null };
        },
      };
    },
  };
  const registry = new SupabaseRegistry(client, "badge_wallets");
  const result = await registry.upsertBadge({ badgeId: "PAY-001", role: "customer", publicKey: "public-address" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.onConflict, "badge_id");
  assert.equal("owner_id" in calls[1].rows, false);
  assert.equal(result.compatibility, "legacy-schema");
});

test("Supabase registry does not hide unrelated schema errors", async () => {
  const client = {
    from() {
      return { upsert: async () => ({ error: { code: "42703", message: "column badge_wallets.enabled does not exist" } }) };
    },
  };
  const registry = new SupabaseRegistry(client, "badge_wallets");
  await assert.rejects(
    registry.upsertBadge({ badgeId: "PAY-001", ownerId: "user-1", role: "customer", publicKey: "public-address" }),
    /enabled does not exist/,
  );
});

test("Supabase registry is optional but rejects partial configuration", () => {
  assert.equal(createSupabaseRegistry({ supabaseUrl: "", supabaseSecretKey: "" }), null);
  assert.throws(() => createSupabaseRegistry({ supabaseUrl: "https://example.supabase.co", supabaseSecretKey: "" }), /configured together/);
});

import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { createApp } from "./app.js";
import { DevnetSolana, MockSolana } from "./solana.js";
import { createSupabaseRegistry } from "./supabase.js";

const config = loadConfig();
if (!process.env.WALLET_ENCRYPTION_KEY && !process.env.DATABASE_ENCRYPTION_KEY) console.warn("Using the insecure development encryption key. Set WALLET_ENCRYPTION_KEY before registering badges.");
const store = new Store(config.databasePath, config.encryptionKey);
const solana = ["devnet", "testnet"].includes(config.solanaMode) ? new DevnetSolana(config.solanaRpcUrl) : new MockSolana();
const registry = createSupabaseRegistry(config);
const app = createApp({ config, store, solana, registry });
app.listen(config.port, () => console.log(`SolarPay backend listening on http://localhost:${config.port} (${config.solanaMode})`));

if (registry) {
  registry.syncBadges(store.listBadges())
    .then(({ count, table }) => console.log(`Synced ${count} badge mappings to Supabase table ${table}`))
    .catch((error) => console.error(error.message));
}

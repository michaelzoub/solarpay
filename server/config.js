import path from "node:path";

export function loadConfig(env = process.env) {
  const solanaMode = env.SOLANA_MODE || "mock";
  return {
    port: Number(env.PORT || 8787),
    appOrigin: env.APP_ORIGIN || "http://localhost:5173",
    databasePath: path.resolve(env.DATABASE_URL || env.DATABASE_PATH || "./data/solarpay.db"),
    encryptionKey: env.WALLET_ENCRYPTION_KEY || env.DATABASE_ENCRYPTION_KEY || "development-only-encryption-key",
    apiKeys: parseApiKeys(env.LAPTOP_API_KEYS || `default:${env.BACKEND_AUTH_SECRET || "change-me-in-production"}`),
    adminApiKey: env.ADMIN_API_KEY || "change-me-admin-key",
    solanaMode,
    solanaRpcUrl: env.SOLANA_RPC_URL || (solanaMode === "testnet" ? "https://api.testnet.solana.com" : "https://api.devnet.solana.com"),
    payerAirdropLamports: Number(env.PAYER_AIRDROP_LAMPORTS || 100_000_000),
    feeReserveLamports: Number(env.FEE_RESERVE_LAMPORTS || 5_000),
    intentTtlSeconds: Number(env.INTENT_TTL_SECONDS || 90),
    supabaseUrl: env.SUPABASE_URL || "",
    supabaseSecretKey: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "",
    supabaseTable: env.SUPABASE_TABLE || "badge_wallets",
  };
}

function parseApiKeys(value) {
  return new Map(value.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    if (separator < 1) throw new Error("LAPTOP_API_KEYS must use id:secret entries");
    return [entry.slice(separator + 1), entry.slice(0, separator)];
  }));
}

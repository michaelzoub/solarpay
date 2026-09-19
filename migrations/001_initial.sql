CREATE TABLE badges (
  badge_id TEXT PRIMARY KEY CHECK(length(badge_id) BETWEEN 1 AND 63),
  role TEXT NOT NULL CHECK(role IN ('merchant','customer')),
  wallet_ciphertext TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  terminal_badge_id TEXT NOT NULL REFERENCES badges(badge_id),
  merchant_address TEXT NOT NULL,
  amount_lamports INTEGER NOT NULL CHECK(amount_lamports > 0),
  memo TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','signed','submitted','confirmed','failed','expired')),
  customer_badge_id TEXT,
  customer_nonce TEXT,
  signature TEXT,
  signed_payload_hash TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX unique_customer_nonce ON payment_intents(customer_badge_id, customer_nonce)
  WHERE customer_badge_id IS NOT NULL AND customer_nonce IS NOT NULL;
CREATE INDEX intent_status_expiry ON payment_intents(status, expires_at);

CREATE TABLE badges_new (
  badge_id TEXT PRIMARY KEY CHECK(length(badge_id) BETWEEN 1 AND 63),
  role TEXT NOT NULL CHECK(role IN ('merchant','customer')),
  wallet_ciphertext TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  owner_id TEXT
);

INSERT INTO badges_new (badge_id, role, wallet_ciphertext, enabled, created_at, owner_id)
  SELECT badge_id, role, wallet_ciphertext, enabled, created_at, owner_id FROM badges;

DROP TABLE badges;
ALTER TABLE badges_new RENAME TO badges;

CREATE UNIQUE INDEX badges_owner_id_unique
  ON badges(owner_id);

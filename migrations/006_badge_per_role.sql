-- One laptop must be able to own a sender AND a merchant badge at the same
-- time. The previous UNIQUE(owner_id) meant registering a second badge could
-- not insert a row, so setup silently renamed the first badge instead. The
-- badge that lost its row then failed approval with CUSTOMER_NOT_FOUND, which
-- is what made a real two-badge payment impossible.
DROP INDEX IF EXISTS badges_owner_id_unique;

CREATE UNIQUE INDEX IF NOT EXISTS badges_owner_role_unique
  ON badges(owner_id, role);

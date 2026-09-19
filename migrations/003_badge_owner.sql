ALTER TABLE badges ADD COLUMN owner_id TEXT;

CREATE UNIQUE INDEX badges_owner_id_unique
  ON badges(owner_id);

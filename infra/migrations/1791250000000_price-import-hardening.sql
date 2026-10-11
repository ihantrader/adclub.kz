-- Up Migration
-- Price list imports hardened (TASK-046.A; ARCHITECTURE 4.66):
--
-- 1. `phase_started_at` is when the worker began the current phase, not
--    when the import was created: an upload waiting in the queue has none
--    and never times out before it is read.
-- 2. `version` counts the confirmations of the columns: a tab that shows an
--    older state can't overwrite a colleague's roles silently; who and when
--    confirmed them last is kept for the answer.
-- 3. A remembered format is found by the SHA-256 of the header's normal
--    form: a header of a hundred long cells no longer exceeds what a btree
--    key can hold. The text stays as it was, outside the key.
-- 4. Refused uploads are remembered for the limit of uploads per company:
--    a refused file costs an attempt like a stored one.

ALTER TABLE price_import
  ALTER COLUMN phase_started_at DROP NOT NULL,
  ALTER COLUMN phase_started_at DROP DEFAULT;

ALTER TABLE price_import
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN columns_confirmed_by_member_id UUID REFERENCES supplier_member (id),
  ADD COLUMN columns_confirmed_at TIMESTAMPTZ;

ALTER TABLE price_import_format ADD COLUMN header_hash TEXT;
UPDATE price_import_format
  SET header_hash = encode(sha256(convert_to(header_key, 'UTF8')), 'hex');
ALTER TABLE price_import_format ALTER COLUMN header_hash SET NOT NULL;
ALTER TABLE price_import_format DROP CONSTRAINT price_import_format_pkey;
ALTER TABLE price_import_format ADD PRIMARY KEY (supplier_id, header_hash);

-- An upload refused before anything was stored (the reason of
-- `PRICE_IMPORT_FILE_INVALID`, or `too_large`). Kept a day: the limit
-- looks back an hour.
CREATE TABLE price_import_refusal (
  id UUID PRIMARY KEY,
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  member_id UUID NOT NULL REFERENCES supplier_member (id),
  reason TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX price_import_refusal_supplier_idx ON price_import_refusal (supplier_id, created_at);
CREATE INDEX price_import_refusal_created_idx ON price_import_refusal (created_at);

-- Down Migration
DROP TABLE price_import_refusal;

-- Headers too long for a btree key could not have been remembered before.
DELETE FROM price_import_format WHERE octet_length(header_key) > 2000;
ALTER TABLE price_import_format DROP CONSTRAINT price_import_format_pkey;
ALTER TABLE price_import_format ADD PRIMARY KEY (supplier_id, header_key);
ALTER TABLE price_import_format DROP COLUMN header_hash;

ALTER TABLE price_import
  DROP COLUMN columns_confirmed_at,
  DROP COLUMN columns_confirmed_by_member_id,
  DROP COLUMN version;

UPDATE price_import SET phase_started_at = created_at WHERE phase_started_at IS NULL;
ALTER TABLE price_import
  ALTER COLUMN phase_started_at SET DEFAULT now(),
  ALTER COLUMN phase_started_at SET NOT NULL;

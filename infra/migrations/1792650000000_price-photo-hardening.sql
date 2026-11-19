-- Up Migration
-- Photographed price lists after the acceptance review (TASK-064.A;
-- ARCHITECTURE 4.93):
-- - a page counts its attempts at being read when AI runs out of time on it
--   (`read_attempts`), and keeps what its first reading gave until the second
--   one is done (`first_reading`), so a retry never pays for it again;
-- - the keys of the rows of every reading of a page (`seen_keys`): an offer
--   whose item is printed on the photo is never «missing» because one reading
--   left its row out (the rows of the review are still only the agreed ones);
-- - `rows` of a page are cleared once the import's rows are written from them:
--   nothing reads them afterwards;
-- - a file stored for an upload is recorded before it is stored
--   (`price_file_pending`) and the record goes in the transaction that makes
--   the file the import's: a file whose upload never came is removed after
--   `price_import_orphan_retention_hours`.

ALTER TABLE price_import_photo_page
  ADD COLUMN read_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN first_reading JSONB,
  ADD COLUMN seen_keys JSONB,
  ADD CONSTRAINT price_import_photo_page_read_attempts_check CHECK (read_attempts >= 0);

ALTER TABLE price_import_photo_page DROP CONSTRAINT price_import_photo_page_rows_check;
UPDATE price_import_photo_page p SET rows = NULL
  WHERE p.rows IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM price_import i
      WHERE i.id = p.import_id AND i.status NOT IN ('parsing', 'needs_retake')
    );
ALTER TABLE price_import_photo_page ADD CONSTRAINT price_import_photo_page_rows_check CHECK (
  (status = 'read') = (row_count IS NOT NULL) AND (rows IS NULL OR status = 'read')
);

CREATE TABLE price_file_pending (
  file_key TEXT PRIMARY KEY,
  supplier_id UUID NOT NULL REFERENCES supplier (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_file_pending_created_idx ON price_file_pending (created_at);

-- Down Migration
DROP TABLE price_file_pending;

ALTER TABLE price_import_photo_page DROP CONSTRAINT price_import_photo_page_rows_check;
-- The older schema wants the rows of a page read; they are gone, an empty list stands in.
UPDATE price_import_photo_page SET rows = '[]'::jsonb WHERE status = 'read' AND rows IS NULL;
ALTER TABLE price_import_photo_page ADD CONSTRAINT price_import_photo_page_rows_check CHECK (
  (status = 'read') = (rows IS NOT NULL AND row_count IS NOT NULL)
);

ALTER TABLE price_import_photo_page
  DROP CONSTRAINT price_import_photo_page_read_attempts_check,
  DROP COLUMN seen_keys,
  DROP COLUMN first_reading,
  DROP COLUMN read_attempts;

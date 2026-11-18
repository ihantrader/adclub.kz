-- Up Migration
-- A photographed price list (TASK-064; ARCHITECTURE 12.1 step 2, 4.93): the
-- pages of an upload, kept privately like a price file and read by AI in the
-- worker into the rows of the import; a page that gave nothing waits to be
-- taken again (`needs_retake`). A row read off a photo keeps its page, the
-- text the model read and what it was unsure of; an uncertain row is applied
-- only after the supplier's «Прочитано верно» (`read_confirmed`).

ALTER TABLE price_import DROP CONSTRAINT price_import_status_check;
ALTER TABLE price_import ADD CONSTRAINT price_import_status_check CHECK (
  status IN (
    'parsing', 'columns', 'reading', 'parsed', 'matching', 'review', 'applying', 'applied',
    'failed', 'expired', 'needs_retake'
  )
);
ALTER TABLE price_import DROP CONSTRAINT price_import_file_kind_check;
ALTER TABLE price_import ADD CONSTRAINT price_import_file_kind_check CHECK (
  file_kind IN ('xlsx', 'csv', 'photo')
);
ALTER TABLE price_import DROP CONSTRAINT price_import_columns_source_check;
ALTER TABLE price_import ADD CONSTRAINT price_import_columns_source_check CHECK (
  columns_source IS NULL OR columns_source IN ('auto', 'remembered', 'supplier', 'photo')
);
-- Why the recognition of the pages waits for AI («ожидает распознавания»).
ALTER TABLE price_import ADD COLUMN photo_ai_waiting TEXT,
  ADD CONSTRAINT price_import_photo_ai_waiting_check CHECK (
    photo_ai_waiting IS NULL OR photo_ai_waiting IN ('unavailable', 'budget')
  );

-- A page of a photographed import. The picture is made smaller and stripped
-- of its metadata before it is kept (`file_key`, private, removed with the
-- import's files after `price_import_file_retention_days`); `rows` — what the
-- page gave, checked (`pricePhotoPage` of the domain), until the import's
-- rows are written from all of its pages.
CREATE TABLE price_import_photo_page (
  import_id UUID NOT NULL REFERENCES price_import (id) ON DELETE CASCADE,
  page_no INTEGER NOT NULL,
  file_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  rows JSONB,
  row_count INTEGER,
  dropped_rows INTEGER,
  retakes INTEGER NOT NULL DEFAULT 0,
  ai_job_id UUID REFERENCES ai_job (id) ON DELETE SET NULL,
  recognized_at TIMESTAMPTZ,
  file_deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (import_id, page_no),
  CONSTRAINT price_import_photo_page_no_check CHECK (page_no BETWEEN 1 AND 99),
  CONSTRAINT price_import_photo_page_byte_size_check CHECK (byte_size > 0),
  CONSTRAINT price_import_photo_page_status_check CHECK (
    status IN ('waiting', 'read', 'no_table', 'unreadable', 'failed')
  ),
  CONSTRAINT price_import_photo_page_rows_check CHECK (
    (status = 'read') = (rows IS NOT NULL AND row_count IS NOT NULL)
  )
);

-- A page taken again: it counts in `price_import_uploads_per_supplier_hour`
-- like an upload (each is a new call to AI). Kept a day, as refusals.
CREATE TABLE price_import_photo_retake (
  id UUID PRIMARY KEY,
  supplier_id UUID NOT NULL REFERENCES supplier (id) ON DELETE CASCADE,
  import_id UUID NOT NULL REFERENCES price_import (id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES supplier_member (id),
  page_no INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_import_photo_retake_supplier_idx
  ON price_import_photo_retake (supplier_id, created_at);

ALTER TABLE price_import_row
  ADD COLUMN photo_page INTEGER,
  ADD COLUMN photo_text TEXT,
  ADD COLUMN photo_uncertain TEXT[],
  ADD COLUMN read_confirmed BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT price_import_row_photo_check CHECK (
    (photo_page IS NULL) = (photo_text IS NULL) AND (photo_page IS NULL) = (photo_uncertain IS NULL)
  );

ALTER TABLE ai_job DROP CONSTRAINT ai_job_kind_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_kind_check CHECK (
  kind IN (
    'price_columns', 'price_match', 'translate', 'compat_check', 'passport_ocr',
    'dashboard_ocr', 'part_photo', 'assistant_turn', 'photo_search', 'attr_fill',
    'review_check', 'maintenance_plan_draft', 'speech_transcribe', 'price_photo'
  )
);

-- Down Migration
DELETE FROM ai_job WHERE kind = 'price_photo';
ALTER TABLE ai_job DROP CONSTRAINT ai_job_kind_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_kind_check CHECK (
  kind IN (
    'price_columns', 'price_match', 'translate', 'compat_check', 'passport_ocr',
    'dashboard_ocr', 'part_photo', 'assistant_turn', 'photo_search', 'attr_fill',
    'review_check', 'maintenance_plan_draft', 'speech_transcribe'
  )
);

ALTER TABLE price_import_row
  DROP CONSTRAINT price_import_row_photo_check,
  DROP COLUMN read_confirmed,
  DROP COLUMN photo_uncertain,
  DROP COLUMN photo_text,
  DROP COLUMN photo_page;

DROP TABLE price_import_photo_retake;
DROP TABLE price_import_photo_page;

-- Photographed imports can't be kept by the older schema.
DELETE FROM supplier_sku_mapping WHERE import_id IN (SELECT id FROM price_import WHERE file_kind = 'photo');
DELETE FROM catalog_request WHERE import_id IN (SELECT id FROM price_import WHERE file_kind = 'photo');
DELETE FROM price_import WHERE file_kind = 'photo';
ALTER TABLE price_import
  DROP CONSTRAINT price_import_photo_ai_waiting_check,
  DROP COLUMN photo_ai_waiting;
ALTER TABLE price_import DROP CONSTRAINT price_import_columns_source_check;
ALTER TABLE price_import ADD CONSTRAINT price_import_columns_source_check CHECK (
  columns_source IS NULL OR columns_source IN ('auto', 'remembered', 'supplier')
);
ALTER TABLE price_import DROP CONSTRAINT price_import_file_kind_check;
ALTER TABLE price_import ADD CONSTRAINT price_import_file_kind_check CHECK (
  file_kind IN ('xlsx', 'csv')
);
ALTER TABLE price_import DROP CONSTRAINT price_import_status_check;
ALTER TABLE price_import ADD CONSTRAINT price_import_status_check CHECK (
  status IN (
    'parsing', 'columns', 'reading', 'parsed', 'matching', 'review', 'applying', 'applied',
    'failed', 'expired'
  )
);

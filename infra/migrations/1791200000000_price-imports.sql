-- Up Migration
-- Price list imports: the upload, the rows read out of the file, the roles
-- of the columns (TASK-046; ARCHITECTURE 5.6, 12.1 steps 1–3, 4.66).
--
-- The file itself is in the object storage (`file_key`, private) and is
-- removed after `price_import_file_retention_days`; the import and its rows
-- stay as the history. Matching the rows with the catalog and applying them
-- add their columns with TASK-047.

CREATE TABLE price_import (
  id UUID PRIMARY KEY,
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  uploaded_by_member_id UUID NOT NULL REFERENCES supplier_member (id),
  uploaded_by_account_id UUID NOT NULL REFERENCES account (id),
  status TEXT NOT NULL DEFAULT 'parsing',
  file_name TEXT,
  file_kind TEXT NOT NULL,
  file_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  same_file_as_import_id UUID REFERENCES price_import (id),
  -- What the file turned out to be.
  sheet_name TEXT,
  encoding TEXT,
  delimiter TEXT,
  header_row_no INTEGER,
  -- Columns of the widest row, the header's normal form (a remembered
  -- format is found by it) and the roles: [{role, source, confidence}].
  column_count INTEGER,
  header_key TEXT,
  column_mapping JSONB,
  columns_source TEXT,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure JSONB,
  -- When the current phase (reading the file, reading the values) began:
  -- a phase longer than `price_import_timeout_minutes` is a failure.
  phase_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at TIMESTAMPTZ,
  file_deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT price_import_status_check CHECK (
    status IN ('parsing', 'columns', 'reading', 'parsed', 'failed')
  ),
  CONSTRAINT price_import_file_kind_check CHECK (file_kind IN ('xlsx', 'csv')),
  CONSTRAINT price_import_columns_source_check CHECK (
    columns_source IS NULL OR columns_source IN ('auto', 'remembered', 'supplier')
  ),
  CONSTRAINT price_import_byte_size_check CHECK (byte_size > 0)
);

-- The company's history, newest first.
CREATE INDEX price_import_supplier_idx ON price_import (supplier_id, created_at DESC, id DESC);
-- «Этот файл уже загружали».
CREATE INDEX price_import_checksum_idx ON price_import (supplier_id, checksum);
-- Files whose retention may have passed.
CREATE INDEX price_import_file_kept_idx ON price_import (created_at) WHERE file_deleted_at IS NULL;
-- Phases that may have stalled.
CREATE INDEX price_import_running_idx ON price_import (phase_started_at)
  WHERE status IN ('parsing', 'reading');

CREATE TABLE price_import_row (
  import_id UUID NOT NULL REFERENCES price_import (id) ON DELETE CASCADE,
  -- As the file numbers it (the row of the sheet, the record of the CSV).
  row_no INTEGER NOT NULL,
  kind TEXT NOT NULL,
  -- The cells by column: text, numbers, nulls.
  raw JSONB NOT NULL,
  -- The values read by the roles: {article, articleNorm, brand, name,
  -- price, availability, quantity, leadDays}; errors — [{code, …}].
  parsed JSONB,
  errors JSONB,
  PRIMARY KEY (import_id, row_no),
  CONSTRAINT price_import_row_kind_check CHECK (
    kind IN ('title', 'header', 'repeat_header', 'group', 'total', 'data')
  )
);

CREATE INDEX price_import_row_errors_idx ON price_import_row (import_id, row_no)
  WHERE errors IS NOT NULL;

-- A company's remembered format: the header of its file → the roles of the
-- columns («Запомнить для следующих загрузок»).
CREATE TABLE price_import_format (
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  header_key TEXT NOT NULL,
  roles JSONB NOT NULL,
  remembered_by_member_id UUID NOT NULL REFERENCES supplier_member (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, header_key)
);

-- Down Migration
DROP TABLE price_import_format;
DROP TABLE price_import_row;
DROP TABLE price_import;

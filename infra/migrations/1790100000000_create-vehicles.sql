-- Up Migration
-- The vehicle catalog (ARCHITECTURE.md 5.3, 4.24; TASK-014): makes, models,
-- generations with their years, modifications (body, engine, transmission,
-- drive, years, market), the reference lists they are made of, engines,
-- and imports of the catalog from a file with their rows.
--
-- Nothing here is ever deleted: a user's car (EPIC-10) and compatibility of
-- items (TASK-015) will point at these rows, so "delete" is archiving. An
-- archived row is not offered for a new choice and stays where it was
-- chosen; an archived make hides its models from clients without touching
-- their status (the same rule as the catalog, ARCHITECTURE 4.15 I148).
--
-- `source` says how a row came to be: `manual` (the administrator or the
-- development seed), `import` (a file), `ai` (reserved for recognition of
-- vehicle documents, stage D — only modifications take it).

-- The reference lists of modifications and engines: body types,
-- transmissions, drives, fuels. Kept by the administrator; the names are
-- written by hand in the three languages (Russian is required) and are
-- never translated automatically. `(id, kind)` is unique so that a foreign
-- key can demand a row of the right kind.
CREATE TABLE vehicle_option (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  code TEXT NOT NULL,
  name_ru TEXT NOT NULL,
  name_kk TEXT,
  name_en TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_option_kind_code_key UNIQUE (kind, code),
  CONSTRAINT vehicle_option_id_kind_key UNIQUE (id, kind),
  CONSTRAINT vehicle_option_kind_check CHECK (kind IN ('body', 'transmission', 'drive', 'fuel')),
  CONSTRAINT vehicle_option_code_check CHECK (code ~ '^[a-z0-9][a-z0-9_]{0,62}$'),
  CONSTRAINT vehicle_option_names_check CHECK (
    btrim(name_ru) <> '' AND (name_kk IS NULL OR btrim(name_kk) <> '')
    AND (name_en IS NULL OR btrim(name_en) <> '')
  ),
  CONSTRAINT vehicle_option_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT vehicle_option_archived_at_check CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT vehicle_option_version_check CHECK (version > 0)
);

-- A name means one option of its kind in each language, whatever the case:
-- an import file names options by code or by name, and a name must not be
-- able to mean two of them.
CREATE UNIQUE INDEX vehicle_option_name_ru_key ON vehicle_option (kind, lower(name_ru));
CREATE UNIQUE INDEX vehicle_option_name_kk_key ON vehicle_option (kind, lower(name_kk))
  WHERE name_kk IS NOT NULL;
CREATE UNIQUE INDEX vehicle_option_name_en_key ON vehicle_option (kind, lower(name_en))
  WHERE name_en IS NOT NULL;

-- A make. Its name and other spellings live in `vehicle_make_spelling`.
CREATE TABLE vehicle_make (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_make_source_check CHECK (source IN ('manual', 'import')),
  CONSTRAINT vehicle_make_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT vehicle_make_archived_at_check CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT vehicle_make_version_check CHECK (version > 0)
);

-- The name of a make (`is_name`, exactly one) and its other spellings
-- (`Geely`, `GEELY Auto`, `Джили`). `key` is the spelling without case and
-- whitespace, unique among all makes, archived ones too — the same rule as
-- brands (ARCHITECTURE 4.17 I158): «Geely» and «GEELY» are one make.
CREATE TABLE vehicle_make_spelling (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  make_id UUID NOT NULL REFERENCES vehicle_make (id),
  text TEXT NOT NULL,
  key TEXT NOT NULL,
  is_name BOOLEAN NOT NULL,
  CONSTRAINT vehicle_make_spelling_key_key UNIQUE (key),
  CONSTRAINT vehicle_make_spelling_text_check CHECK (btrim(text) <> ''),
  CONSTRAINT vehicle_make_spelling_key_check CHECK (key <> '' AND key !~ '\s' AND key = lower(key))
);

CREATE UNIQUE INDEX vehicle_make_spelling_name_key ON vehicle_make_spelling (make_id) WHERE is_name;
CREATE INDEX vehicle_make_spelling_make_idx ON vehicle_make_spelling (make_id);

-- A model of a make. It may move to another make; its spellings follow
-- (`ON UPDATE CASCADE` of the composite key below).
CREATE TABLE vehicle_model (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  make_id UUID NOT NULL REFERENCES vehicle_make (id),
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_model_id_make_key UNIQUE (id, make_id),
  CONSTRAINT vehicle_model_source_check CHECK (source IN ('manual', 'import')),
  CONSTRAINT vehicle_model_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT vehicle_model_archived_at_check CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT vehicle_model_version_check CHECK (version > 0)
);

CREATE INDEX vehicle_model_make_idx ON vehicle_model (make_id);

-- The name and spellings of a model, unique within its make (`Coolray` of
-- Geely and a `Coolray` of another make are different models).
CREATE TABLE vehicle_model_spelling (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id UUID NOT NULL,
  make_id UUID NOT NULL,
  text TEXT NOT NULL,
  key TEXT NOT NULL,
  is_name BOOLEAN NOT NULL,
  CONSTRAINT vehicle_model_spelling_model_fkey FOREIGN KEY (model_id, make_id)
    REFERENCES vehicle_model (id, make_id) ON UPDATE CASCADE,
  CONSTRAINT vehicle_model_spelling_make_key_key UNIQUE (make_id, key),
  CONSTRAINT vehicle_model_spelling_text_check CHECK (btrim(text) <> ''),
  CONSTRAINT vehicle_model_spelling_key_check CHECK (key <> '' AND key !~ '\s' AND key = lower(key))
);

CREATE UNIQUE INDEX vehicle_model_spelling_name_key ON vehicle_model_spelling (model_id) WHERE is_name;
CREATE INDEX vehicle_model_spelling_model_idx ON vehicle_model_spelling (model_id);

-- A generation of a model with its years. `year_to` is empty while the
-- generation is still made. `name_key` is the name without case (and runs
-- of spaces as one): unique within the model.
CREATE TABLE vehicle_generation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id UUID NOT NULL REFERENCES vehicle_model (id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  year_from SMALLINT NOT NULL,
  year_to SMALLINT,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_generation_model_name_key UNIQUE (model_id, name_key),
  CONSTRAINT vehicle_generation_name_check CHECK (btrim(name) <> '' AND name_key <> ''),
  CONSTRAINT vehicle_generation_years_check CHECK (
    year_from BETWEEN 1900 AND 2100
    AND (year_to IS NULL OR (year_to BETWEEN 1900 AND 2100 AND year_to >= year_from))
  ),
  CONSTRAINT vehicle_generation_source_check CHECK (source IN ('manual', 'import')),
  CONSTRAINT vehicle_generation_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT vehicle_generation_archived_at_check CHECK (
    (status = 'archived') = (archived_at IS NOT NULL)
  ),
  CONSTRAINT vehicle_generation_version_check CHECK (version > 0)
);

-- An engine: one is used by many modifications. Its code and other
-- spellings live in `vehicle_engine_spelling`; the fuel is an option of
-- kind `fuel`. Displacement is empty for an electric motor, power when
-- the source doesn't give it.
CREATE TABLE vehicle_engine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  displacement_l NUMERIC(4, 2),
  fuel_id UUID NOT NULL,
  fuel_kind TEXT NOT NULL DEFAULT 'fuel',
  power_hp INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_engine_fuel_fkey FOREIGN KEY (fuel_id, fuel_kind)
    REFERENCES vehicle_option (id, kind),
  CONSTRAINT vehicle_engine_fuel_kind_check CHECK (fuel_kind = 'fuel'),
  CONSTRAINT vehicle_engine_displacement_check CHECK (
    displacement_l IS NULL OR displacement_l BETWEEN 0.1 AND 20
  ),
  CONSTRAINT vehicle_engine_power_check CHECK (power_hp IS NULL OR power_hp BETWEEN 1 AND 3000),
  CONSTRAINT vehicle_engine_source_check CHECK (source IN ('manual', 'import')),
  CONSTRAINT vehicle_engine_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT vehicle_engine_archived_at_check CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT vehicle_engine_version_check CHECK (version > 0)
);

-- The code of an engine (`is_code`, exactly one: `JLH-4G20TD`) and its
-- other spellings (`4G20TD`); the key is unique among all engines.
CREATE TABLE vehicle_engine_spelling (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engine_id UUID NOT NULL REFERENCES vehicle_engine (id),
  text TEXT NOT NULL,
  key TEXT NOT NULL,
  is_code BOOLEAN NOT NULL,
  CONSTRAINT vehicle_engine_spelling_key_key UNIQUE (key),
  CONSTRAINT vehicle_engine_spelling_text_check CHECK (btrim(text) <> ''),
  CONSTRAINT vehicle_engine_spelling_key_check CHECK (key <> '' AND key !~ '\s' AND key = lower(key))
);

CREATE UNIQUE INDEX vehicle_engine_spelling_code_key ON vehicle_engine_spelling (engine_id)
  WHERE is_code;
CREATE INDEX vehicle_engine_spelling_engine_idx ON vehicle_engine_spelling (engine_id);

-- An import of the catalog from a file (TASK-014 requirement 3). The file
-- is read at upload; its rows are kept in `vehicle_import_row`, the report
-- and the result here. Statuses: `parsing` (rows being checked by a
-- background job), `ready` (the report waits for the administrator),
-- `applying`, `applied`, `cancelled` (the administrator declined it),
-- `failed` (the check or the application broke off; `error` says why).
CREATE TABLE vehicle_import (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'parsing',
  file_name TEXT,
  byte_size INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  delimiter TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  report JSONB,
  result JSONB,
  error TEXT,
  uploaded_by_admin_id UUID NOT NULL REFERENCES admin_user (id),
  uploaded_by_account_id UUID NOT NULL REFERENCES account (id),
  applied_by_admin_id UUID REFERENCES admin_user (id),
  applied_by_account_id UUID REFERENCES account (id),
  phase_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  analyzed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_import_status_check CHECK (
    status IN ('parsing', 'ready', 'applying', 'applied', 'cancelled', 'failed')
  ),
  CONSTRAINT vehicle_import_size_check CHECK (byte_size > 0 AND row_count > 0),
  CONSTRAINT vehicle_import_delimiter_check CHECK (delimiter IN (',', ';', E'\t')),
  CONSTRAINT vehicle_import_report_check CHECK (
    (status IN ('parsing', 'failed', 'cancelled')) OR report IS NOT NULL
  ),
  CONSTRAINT vehicle_import_result_check CHECK ((status = 'applied') = (result IS NOT NULL)),
  CONSTRAINT vehicle_import_applied_by_check CHECK (
    (applied_by_admin_id IS NULL) = (applied_by_account_id IS NULL)
  )
);

CREATE INDEX vehicle_import_created_idx ON vehicle_import (created_at DESC, id DESC);
CREATE INDEX vehicle_import_active_idx ON vehicle_import (phase_started_at)
  WHERE status IN ('parsing', 'applying');

-- One row of an import file: its values by column as read, what the check
-- planned for it (`planned` — `create`, `update`, `unchanged`, `rejected`
-- with `reasons`) and what applying it did (`outcome`, `outcome_reasons`,
-- `modification_id`). `fingerprint` is the hash of the normalized values:
-- two rows with the same content are one (idempotency by content).
-- `row_number` is the row as a spreadsheet numbers it: the header is 1.
CREATE TABLE vehicle_import_row (
  import_id UUID NOT NULL REFERENCES vehicle_import (id),
  row_number INTEGER NOT NULL,
  "values" JSONB NOT NULL,
  fingerprint TEXT NOT NULL,
  planned TEXT,
  reasons JSONB,
  outcome TEXT,
  outcome_reasons JSONB,
  modification_id UUID,
  PRIMARY KEY (import_id, row_number),
  CONSTRAINT vehicle_import_row_number_check CHECK (row_number >= 2),
  CONSTRAINT vehicle_import_row_planned_check CHECK (
    planned IS NULL OR planned IN ('create', 'update', 'unchanged', 'rejected')
  ),
  CONSTRAINT vehicle_import_row_outcome_check CHECK (
    outcome IS NULL OR outcome IN ('created', 'updated', 'unchanged', 'rejected')
  )
);

-- A modification: a generation with a body, an engine, a transmission, a
-- drive and years, of the Kazakhstan market or the global one (PRODUCT
-- 7.7). The same set of generation, body, engine, transmission, drive and
-- years is one modification (archived ones included: restore it rather
-- than make a second one); `NULLS NOT DISTINCT` makes two open-ended ones
-- equal too. That its years lie within the generation's is held by the
-- triggers below.
CREATE TABLE vehicle_modification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id UUID NOT NULL REFERENCES vehicle_generation (id),
  body_type_id UUID NOT NULL,
  body_type_kind TEXT NOT NULL DEFAULT 'body',
  engine_id UUID NOT NULL REFERENCES vehicle_engine (id),
  transmission_type_id UUID NOT NULL,
  transmission_type_kind TEXT NOT NULL DEFAULT 'transmission',
  drive_type_id UUID NOT NULL,
  drive_type_kind TEXT NOT NULL DEFAULT 'drive',
  year_from SMALLINT NOT NULL,
  year_to SMALLINT,
  market TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  import_id UUID REFERENCES vehicle_import (id),
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_modification_body_fkey FOREIGN KEY (body_type_id, body_type_kind)
    REFERENCES vehicle_option (id, kind),
  CONSTRAINT vehicle_modification_transmission_fkey
    FOREIGN KEY (transmission_type_id, transmission_type_kind) REFERENCES vehicle_option (id, kind),
  CONSTRAINT vehicle_modification_drive_fkey FOREIGN KEY (drive_type_id, drive_type_kind)
    REFERENCES vehicle_option (id, kind),
  CONSTRAINT vehicle_modification_kinds_check CHECK (
    body_type_kind = 'body' AND transmission_type_kind = 'transmission' AND drive_type_kind = 'drive'
  ),
  CONSTRAINT vehicle_modification_identity_key UNIQUE NULLS NOT DISTINCT (
    generation_id, body_type_id, engine_id, transmission_type_id, drive_type_id, year_from, year_to
  ),
  CONSTRAINT vehicle_modification_years_check CHECK (
    year_from BETWEEN 1900 AND 2100
    AND (year_to IS NULL OR (year_to BETWEEN 1900 AND 2100 AND year_to >= year_from))
  ),
  CONSTRAINT vehicle_modification_market_check CHECK (market IN ('kz', 'global')),
  CONSTRAINT vehicle_modification_source_check CHECK (source IN ('manual', 'import', 'ai')),
  CONSTRAINT vehicle_modification_import_check CHECK (import_id IS NULL OR source = 'import'),
  CONSTRAINT vehicle_modification_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT vehicle_modification_archived_at_check CHECK (
    (status = 'archived') = (archived_at IS NOT NULL)
  ),
  CONSTRAINT vehicle_modification_version_check CHECK (version > 0)
);

CREATE INDEX vehicle_modification_generation_idx ON vehicle_modification (generation_id);
CREATE INDEX vehicle_modification_engine_idx ON vehicle_modification (engine_id);
CREATE INDEX vehicle_modification_created_idx ON vehicle_modification (created_at DESC, id DESC);

-- The years of a modification lie within its generation's: it can't start
-- before the generation, and it can't go on (or be still made) after the
-- generation ended. Checked when a modification is written and when a
-- generation's years change, so neither side can break it alone.
CREATE FUNCTION vehicle_modification_years_within() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  gen RECORD;
BEGIN
  SELECT year_from, year_to INTO gen FROM vehicle_generation WHERE id = NEW.generation_id;
  IF NEW.year_from < gen.year_from
    OR (gen.year_to IS NOT NULL AND (NEW.year_to IS NULL OR NEW.year_to > gen.year_to))
  THEN
    RAISE EXCEPTION 'vehicle_modification years % – % are outside generation years % – %',
      NEW.year_from, NEW.year_to, gen.year_from, gen.year_to
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vehicle_modification_years_within';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vehicle_modification_years_within
  BEFORE INSERT OR UPDATE OF generation_id, year_from, year_to ON vehicle_modification
  FOR EACH ROW EXECUTE FUNCTION vehicle_modification_years_within();

CREATE FUNCTION vehicle_generation_years_cover() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM vehicle_modification m
    WHERE m.generation_id = NEW.id
      AND (m.year_from < NEW.year_from
        OR (NEW.year_to IS NOT NULL AND (m.year_to IS NULL OR m.year_to > NEW.year_to)))
  ) THEN
    RAISE EXCEPTION 'vehicle_generation years % – % leave out some of its modifications',
      NEW.year_from, NEW.year_to
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vehicle_modification_years_within';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vehicle_generation_years_cover
  AFTER UPDATE OF year_from, year_to ON vehicle_generation
  FOR EACH ROW EXECUTE FUNCTION vehicle_generation_years_cover();

-- Down Migration
DROP TRIGGER vehicle_generation_years_cover ON vehicle_generation;
DROP FUNCTION vehicle_generation_years_cover();
DROP TRIGGER vehicle_modification_years_within ON vehicle_modification;
DROP FUNCTION vehicle_modification_years_within();
DROP TABLE vehicle_modification;
DROP TABLE vehicle_import_row;
DROP TABLE vehicle_import;
DROP TABLE vehicle_engine_spelling;
DROP TABLE vehicle_engine;
DROP TABLE vehicle_generation;
DROP TABLE vehicle_model_spelling;
DROP TABLE vehicle_model;
DROP TABLE vehicle_make_spelling;
DROP TABLE vehicle_make;
DROP TABLE vehicle_option;

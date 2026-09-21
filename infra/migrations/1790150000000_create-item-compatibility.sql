-- Up Migration
-- Compatibility of catalog items with cars (ARCHITECTURE.md 5.3, 4.25;
-- TASK-015; PRODUCT 7.5, D-004, D-029).
--
-- `item_compatibility` is the approved layer: the only one the result for a
-- car is computed from. A record names the cars it covers with the
-- precision that is known — a make (required), and optionally a model, a
-- generation, a body, an engine, a transmission, a drive and years; an
-- empty level means «any». `item_compatibility_proposal` keeps what a
-- supplier (and later the AI, stage D) proposes: it never changes a result
-- until an administrator approves it into a record (D-004).
--
-- Rows are never deleted: an administrator archives a record, a proposal
-- ends approved or rejected. Records point at the vehicle catalog, whose
-- rows are never deleted either (ARCHITECTURE 4.24 I214); an archived
-- make, model or engine leaves the records as they are, so the result for
-- a car chosen before the archiving doesn't change.

-- An item of any type may be named together with its type: the records
-- below take only goods (parts and products), never services.
ALTER TABLE catalog_item ADD CONSTRAINT catalog_item_id_type_key UNIQUE (id, item_type);

CREATE TABLE item_compatibility (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL,
  item_type TEXT NOT NULL,
  make_id UUID NOT NULL REFERENCES vehicle_make (id),
  model_id UUID REFERENCES vehicle_model (id),
  generation_id UUID REFERENCES vehicle_generation (id),
  body_type_id UUID,
  body_type_kind TEXT NOT NULL DEFAULT 'body',
  engine_id UUID REFERENCES vehicle_engine (id),
  transmission_type_id UUID,
  transmission_type_kind TEXT NOT NULL DEFAULT 'transmission',
  drive_type_id UUID,
  drive_type_kind TEXT NOT NULL DEFAULT 'drive',
  year_from SMALLINT,
  year_to SMALLINT,
  status TEXT NOT NULL DEFAULT 'approved',
  archived_at TIMESTAMPTZ,
  -- `admin` — written by an administrator; `supplier` — a supplier's
  -- proposal the administrator approved; `ai` — reserved (stage D);
  -- `copy` — copied from an analog (`copied_from_id`).
  source TEXT NOT NULL,
  evidence TEXT NOT NULL,
  copied_from_id UUID REFERENCES item_compatibility (id),
  created_by_account_id UUID REFERENCES account (id),
  reviewed_by_admin_id UUID REFERENCES admin_user (id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT item_compatibility_item_fkey FOREIGN KEY (item_id, item_type)
    REFERENCES catalog_item (id, item_type),
  CONSTRAINT item_compatibility_item_type_check CHECK (item_type IN ('part', 'generic')),
  CONSTRAINT item_compatibility_body_fkey FOREIGN KEY (body_type_id, body_type_kind)
    REFERENCES vehicle_option (id, kind),
  CONSTRAINT item_compatibility_transmission_fkey
    FOREIGN KEY (transmission_type_id, transmission_type_kind) REFERENCES vehicle_option (id, kind),
  CONSTRAINT item_compatibility_drive_fkey FOREIGN KEY (drive_type_id, drive_type_kind)
    REFERENCES vehicle_option (id, kind),
  CONSTRAINT item_compatibility_kinds_check CHECK (
    body_type_kind = 'body' AND transmission_type_kind = 'transmission' AND drive_type_kind = 'drive'
  ),
  CONSTRAINT item_compatibility_generation_model_check CHECK (
    generation_id IS NULL OR model_id IS NOT NULL
  ),
  CONSTRAINT item_compatibility_years_check CHECK (
    (year_from IS NULL OR year_from BETWEEN 1900 AND 2100)
    AND (year_to IS NULL OR year_to BETWEEN 1900 AND 2100)
    AND (year_from IS NULL OR year_to IS NULL OR year_to >= year_from)
  ),
  CONSTRAINT item_compatibility_status_check CHECK (status IN ('approved', 'archived')),
  CONSTRAINT item_compatibility_archived_at_check CHECK (
    (status = 'archived') = (archived_at IS NOT NULL)
  ),
  CONSTRAINT item_compatibility_source_check CHECK (source IN ('admin', 'supplier', 'ai', 'copy')),
  CONSTRAINT item_compatibility_copy_check CHECK ((source = 'copy') = (copied_from_id IS NOT NULL)),
  CONSTRAINT item_compatibility_evidence_check CHECK (
    btrim(evidence) <> '' AND char_length(evidence) <= 1000
  ),
  CONSTRAINT item_compatibility_version_check CHECK (version > 0)
);

-- One approved record per set of conditions of an item: the same cars are
-- never listed twice (archived records may repeat — they are history).
CREATE UNIQUE INDEX item_compatibility_approved_key ON item_compatibility
  (item_id, make_id, model_id, generation_id, body_type_id, engine_id, transmission_type_id,
   drive_type_id, year_from, year_to) NULLS NOT DISTINCT
  WHERE status = 'approved';

-- The result for many items at once reads the approved records by item.
CREATE INDEX item_compatibility_item_idx ON item_compatibility (item_id) WHERE status = 'approved';

-- A proposal: the same conditions, who proposed it and on what grounds,
-- and how it was reviewed. `pending` → `approved` (a record was created,
-- or an equal approved record already existed — `resolution`) or
-- `rejected` (with the reason the supplier sees).
CREATE TABLE item_compatibility_proposal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL,
  item_type TEXT NOT NULL,
  make_id UUID NOT NULL REFERENCES vehicle_make (id),
  model_id UUID REFERENCES vehicle_model (id),
  generation_id UUID REFERENCES vehicle_generation (id),
  body_type_id UUID,
  body_type_kind TEXT NOT NULL DEFAULT 'body',
  engine_id UUID REFERENCES vehicle_engine (id),
  transmission_type_id UUID,
  transmission_type_kind TEXT NOT NULL DEFAULT 'transmission',
  drive_type_id UUID,
  drive_type_kind TEXT NOT NULL DEFAULT 'drive',
  year_from SMALLINT,
  year_to SMALLINT,
  evidence TEXT NOT NULL,
  -- `supplier`; `ai` is reserved for the check of stage D (no supplier).
  source TEXT NOT NULL,
  supplier_id UUID REFERENCES supplier (id),
  supplier_member_id UUID,
  proposed_by_account_id UUID REFERENCES account (id),
  status TEXT NOT NULL DEFAULT 'pending',
  resolution TEXT,
  approved_with_changes BOOLEAN NOT NULL DEFAULT false,
  compatibility_id UUID REFERENCES item_compatibility (id),
  rejection_reason TEXT,
  reviewed_by_admin_id UUID REFERENCES admin_user (id),
  reviewed_by_account_id UUID REFERENCES account (id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT item_compatibility_proposal_item_fkey FOREIGN KEY (item_id, item_type)
    REFERENCES catalog_item (id, item_type),
  CONSTRAINT item_compatibility_proposal_item_type_check CHECK (item_type IN ('part', 'generic')),
  CONSTRAINT item_compatibility_proposal_member_fkey FOREIGN KEY (supplier_member_id, supplier_id)
    REFERENCES supplier_member (id, supplier_id),
  CONSTRAINT item_compatibility_proposal_body_fkey FOREIGN KEY (body_type_id, body_type_kind)
    REFERENCES vehicle_option (id, kind),
  CONSTRAINT item_compatibility_proposal_transmission_fkey
    FOREIGN KEY (transmission_type_id, transmission_type_kind) REFERENCES vehicle_option (id, kind),
  CONSTRAINT item_compatibility_proposal_drive_fkey FOREIGN KEY (drive_type_id, drive_type_kind)
    REFERENCES vehicle_option (id, kind),
  CONSTRAINT item_compatibility_proposal_kinds_check CHECK (
    body_type_kind = 'body' AND transmission_type_kind = 'transmission' AND drive_type_kind = 'drive'
  ),
  CONSTRAINT item_compatibility_proposal_generation_model_check CHECK (
    generation_id IS NULL OR model_id IS NOT NULL
  ),
  CONSTRAINT item_compatibility_proposal_years_check CHECK (
    (year_from IS NULL OR year_from BETWEEN 1900 AND 2100)
    AND (year_to IS NULL OR year_to BETWEEN 1900 AND 2100)
    AND (year_from IS NULL OR year_to IS NULL OR year_to >= year_from)
  ),
  CONSTRAINT item_compatibility_proposal_evidence_check CHECK (
    btrim(evidence) <> '' AND char_length(evidence) <= 1000
  ),
  CONSTRAINT item_compatibility_proposal_source_check CHECK (
    (source = 'supplier' AND supplier_id IS NOT NULL AND supplier_member_id IS NOT NULL)
    OR (source = 'ai' AND supplier_id IS NULL AND supplier_member_id IS NULL)
  ),
  CONSTRAINT item_compatibility_proposal_status_check CHECK (
    status IN ('pending', 'approved', 'rejected')
  ),
  CONSTRAINT item_compatibility_proposal_review_check CHECK (
    (status = 'pending' AND reviewed_at IS NULL AND resolution IS NULL
      AND compatibility_id IS NULL AND rejection_reason IS NULL)
    OR (status = 'approved' AND reviewed_at IS NOT NULL AND compatibility_id IS NOT NULL
      AND resolution IN ('created', 'already_approved') AND rejection_reason IS NULL)
    OR (status = 'rejected' AND reviewed_at IS NOT NULL AND compatibility_id IS NULL
      AND resolution IS NULL AND btrim(rejection_reason) <> '')
  )
);

-- A supplier doesn't wait on the same proposal twice.
CREATE UNIQUE INDEX item_compatibility_proposal_pending_key ON item_compatibility_proposal
  (supplier_id, item_id, make_id, model_id, generation_id, body_type_id, engine_id,
   transmission_type_id, drive_type_id, year_from, year_to) NULLS NOT DISTINCT
  WHERE status = 'pending';

CREATE INDEX item_compatibility_proposal_queue_idx ON item_compatibility_proposal
  (status, created_at DESC, id DESC);
CREATE INDEX item_compatibility_proposal_supplier_idx ON item_compatibility_proposal
  (supplier_id, created_at DESC, id DESC);
CREATE INDEX item_compatibility_proposal_item_idx ON item_compatibility_proposal (item_id);

-- The levels of a record agree with the vehicle catalog: the model is of
-- the make, the generation of the model. The server checks it first and
-- answers why; this is the last line.
CREATE FUNCTION item_compatibility_levels_agree() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM vehicle_model WHERE id = NEW.model_id AND make_id = NEW.make_id
  ) THEN
    RAISE EXCEPTION 'compatibility model % is not of make %', NEW.model_id, NEW.make_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'item_compatibility_levels_agree';
  END IF;
  IF NEW.generation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM vehicle_generation WHERE id = NEW.generation_id AND model_id = NEW.model_id
  ) THEN
    RAISE EXCEPTION 'compatibility generation % is not of model %', NEW.generation_id, NEW.model_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'item_compatibility_levels_agree';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER item_compatibility_levels_agree
  BEFORE INSERT OR UPDATE OF make_id, model_id, generation_id ON item_compatibility
  FOR EACH ROW EXECUTE FUNCTION item_compatibility_levels_agree();

CREATE TRIGGER item_compatibility_proposal_levels_agree
  BEFORE INSERT OR UPDATE OF make_id, model_id, generation_id ON item_compatibility_proposal
  FOR EACH ROW EXECUTE FUNCTION item_compatibility_levels_agree();

-- A model moved to another make, a generation to another model
-- (ARCHITECTURE 4.24 I221): the records and proposals naming it follow, so
-- they keep meaning the same cars.
CREATE FUNCTION item_compatibility_follow_model() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE item_compatibility SET make_id = NEW.make_id WHERE model_id = NEW.id;
  UPDATE item_compatibility_proposal SET make_id = NEW.make_id WHERE model_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER item_compatibility_follow_model
  AFTER UPDATE OF make_id ON vehicle_model
  FOR EACH ROW WHEN (OLD.make_id IS DISTINCT FROM NEW.make_id)
  EXECUTE FUNCTION item_compatibility_follow_model();

CREATE FUNCTION item_compatibility_follow_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_make UUID;
BEGIN
  SELECT make_id INTO new_make FROM vehicle_model WHERE id = NEW.model_id;
  UPDATE item_compatibility SET model_id = NEW.model_id, make_id = new_make
    WHERE generation_id = NEW.id;
  UPDATE item_compatibility_proposal SET model_id = NEW.model_id, make_id = new_make
    WHERE generation_id = NEW.id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER item_compatibility_follow_generation
  AFTER UPDATE OF model_id ON vehicle_generation
  FOR EACH ROW WHEN (OLD.model_id IS DISTINCT FROM NEW.model_id)
  EXECUTE FUNCTION item_compatibility_follow_generation();

-- Down Migration
DROP TRIGGER item_compatibility_follow_generation ON vehicle_generation;
DROP FUNCTION item_compatibility_follow_generation();
DROP TRIGGER item_compatibility_follow_model ON vehicle_model;
DROP FUNCTION item_compatibility_follow_model();
DROP TRIGGER item_compatibility_proposal_levels_agree ON item_compatibility_proposal;
DROP TRIGGER item_compatibility_levels_agree ON item_compatibility;
DROP FUNCTION item_compatibility_levels_agree();
DROP TABLE item_compatibility_proposal;
DROP TABLE item_compatibility;
ALTER TABLE catalog_item DROP CONSTRAINT catalog_item_id_type_key;

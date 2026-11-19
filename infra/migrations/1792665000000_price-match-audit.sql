-- Up Migration
-- The administrator's spot check of AI matches of price lists (TASK-065;
-- D-075; ARCHITECTURE 4.94):
-- - a row matched by AI keeps the `ai_job` of the call (the model and the
--   cost of the answer the supplier accepted);
-- - the company's memory tells an AI match the supplier accepted
--   (`supplier_ai`) from one the supplier chose themself;
-- - `price_match_audit`: the applied rows put aside for a check, and the
--   administrator's verdict; only imports applied from now on — rows applied
--   before are not sampled after the fact;
-- - an offer withdrawn because its match was wrong (`match_corrected`).

ALTER TABLE price_import_row ADD COLUMN ai_job_id UUID;

ALTER TABLE supplier_sku_mapping DROP CONSTRAINT supplier_sku_mapping_confirmed_by_check;
ALTER TABLE supplier_sku_mapping ADD CONSTRAINT supplier_sku_mapping_confirmed_by_check CHECK (
  confirmed_by IN ('supplier', 'supplier_ai', 'admin', 'auto')
);

ALTER TABLE offer DROP CONSTRAINT offer_withdrawn_reason_check;
ALTER TABLE offer ADD CONSTRAINT offer_withdrawn_reason_check CHECK (
  withdrawn_reason IS NULL
  OR withdrawn_reason IN ('manual', 'missing_in_import', 'out_of_stock_in_import', 'match_corrected')
);

CREATE TABLE price_match_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID NOT NULL,
  row_no INTEGER NOT NULL,
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  -- The item AI chose and the supplier accepted, with AI's confidence.
  ai_item_id UUID NOT NULL REFERENCES catalog_item (id),
  ai_confidence NUMERIC(4, 3) NOT NULL,
  -- `below` — under `price_match_audit_always_below`; `share` — drawn.
  reason TEXT NOT NULL,
  -- The offer the row made, changed or confirmed.
  offer_id UUID REFERENCES offer (id),
  status TEXT NOT NULL DEFAULT 'pending',
  correct_item_id UUID REFERENCES catalog_item (id),
  not_in_catalog BOOLEAN NOT NULL DEFAULT false,
  comment TEXT,
  -- What «Неверно» did: the memory removed, the offer withdrawn or kept and why.
  result JSONB,
  decided_by_admin_id UUID REFERENCES admin_user (id),
  decided_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT price_match_audit_row_fkey FOREIGN KEY (import_id, row_no)
    REFERENCES price_import_row (import_id, row_no) ON DELETE CASCADE,
  CONSTRAINT price_match_audit_row_key UNIQUE (import_id, row_no),
  CONSTRAINT price_match_audit_status_check CHECK (status IN ('pending', 'correct', 'wrong')),
  CONSTRAINT price_match_audit_reason_check CHECK (reason IN ('below', 'share')),
  CONSTRAINT price_match_audit_confidence_check CHECK (ai_confidence >= 0 AND ai_confidence <= 1),
  CONSTRAINT price_match_audit_decision_check CHECK (
    (status = 'pending') = (decided_at IS NULL AND decided_by_admin_id IS NULL)
  ),
  CONSTRAINT price_match_audit_wrong_check CHECK (
    status = 'wrong'
    OR (correct_item_id IS NULL AND NOT not_in_catalog AND result IS NULL)
  ),
  CONSTRAINT price_match_audit_correction_check CHECK (
    NOT (not_in_catalog AND correct_item_id IS NOT NULL)
    AND (correct_item_id IS NULL OR correct_item_id <> ai_item_id)
  ),
  CONSTRAINT price_match_audit_comment_check CHECK (comment IS NULL OR length(comment) <= 1000),
  CONSTRAINT price_match_audit_version_check CHECK (version >= 1)
);

-- The queue, oldest first; the supplier's corrections; the accuracy by period.
CREATE INDEX price_match_audit_pending_idx ON price_match_audit (created_at, id)
  WHERE status = 'pending';
CREATE INDEX price_match_audit_supplier_idx ON price_match_audit (supplier_id, created_at);
CREATE INDEX price_match_audit_decided_idx ON price_match_audit (decided_at)
  WHERE status <> 'pending';

-- Down Migration
DROP TABLE price_match_audit;

UPDATE offer SET withdrawn_reason = 'manual' WHERE withdrawn_reason = 'match_corrected';
ALTER TABLE offer DROP CONSTRAINT offer_withdrawn_reason_check;
ALTER TABLE offer ADD CONSTRAINT offer_withdrawn_reason_check CHECK (
  withdrawn_reason IS NULL OR withdrawn_reason IN ('manual', 'missing_in_import', 'out_of_stock_in_import')
);

UPDATE supplier_sku_mapping SET confirmed_by = 'supplier' WHERE confirmed_by = 'supplier_ai';
ALTER TABLE supplier_sku_mapping DROP CONSTRAINT supplier_sku_mapping_confirmed_by_check;
ALTER TABLE supplier_sku_mapping ADD CONSTRAINT supplier_sku_mapping_confirmed_by_check CHECK (
  confirmed_by IN ('supplier', 'admin', 'auto')
);

ALTER TABLE price_import_row DROP COLUMN ai_job_id;

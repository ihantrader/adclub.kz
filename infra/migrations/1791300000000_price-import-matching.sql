-- Up Migration
-- Price list imports matched with the catalog and applied, and the requests
-- to add an item the administrator answers (TASK-047; ARCHITECTURE 5.6,
-- 12.1 steps 4–8, 4.67).
--
-- 1. An import goes on after `parsed`: `matching` (the worker matches the
--    rows; waits there while AI can't be reached), `review` (the supplier
--    decides, the decisions are kept here), `applying`, `applied`; an
--    unfinished review is `expired` after `price_import_review_days`.
-- 2. A row gets its group, how it was matched, the item, candidates, AI's
--    answer, a note, a matching error; the supplier's decision with who took
--    it; what applying did to it.
-- 3. `supplier_sku_mapping` — what the company's rows were matched to (or
--    that the supplier skipped them, or that the catalog has no such item):
--    the next price list finds them without AI and without a review.
-- 4. `catalog_request` — a row not found, sent to the administrator; one
--    open request per article (or name) of a company.
-- 5. An offer withdrawn by «нет в наличии» of a price list has its own
--    reason: it comes back with the next price list that has it in stock.

ALTER TABLE price_import DROP CONSTRAINT price_import_status_check;
ALTER TABLE price_import ADD CONSTRAINT price_import_status_check CHECK (
  status IN (
    'parsing', 'columns', 'reading', 'parsed', 'matching', 'review', 'applying', 'applied',
    'failed', 'expired'
  )
);

ALTER TABLE price_import
  -- «Пропали из файла»: one choice for the group, with no default.
  ADD COLUMN missing_action TEXT,
  ADD COLUMN missing_decided_by_member_id UUID REFERENCES supplier_member (id),
  ADD COLUMN missing_decided_at TIMESTAMPTZ,
  -- The last change by a person (the columns, a decision, the choice, applying).
  ADD COLUMN changed_by_member_id UUID REFERENCES supplier_member (id),
  ADD COLUMN changed_at TIMESTAMPTZ,
  -- When matching ended and until when the review is kept.
  ADD COLUMN matched_at TIMESTAMPTZ,
  ADD COLUMN review_until TIMESTAMPTZ,
  ADD COLUMN applied_by_member_id UUID REFERENCES supplier_member (id),
  ADD COLUMN applied_at TIMESTAMPTZ,
  -- {updated, created, unchanged, returned, withdrawnOutOfStock,
  --  withdrawnMissing, requested, skipped, notApplied: [{reason, rows}]}
  ADD COLUMN result JSONB,
  ADD CONSTRAINT price_import_missing_action_check CHECK (
    missing_action IS NULL OR missing_action IN ('withdraw', 'keep')
  ),
  ADD CONSTRAINT price_import_applied_check CHECK (
    (status IN ('applying', 'applied')) = (applied_at IS NOT NULL AND applied_by_member_id IS NOT NULL)
  );

-- Reviews that may expire, matching that may have stalled.
CREATE INDEX price_import_review_idx ON price_import (review_until) WHERE status = 'review';
CREATE INDEX price_import_matching_idx ON price_import (updated_at) WHERE status = 'matching';

ALTER TABLE price_import_row
  -- What the row is known by: the article, or the name without one.
  ADD COLUMN match_key_kind TEXT,
  ADD COLUMN match_key TEXT,
  -- `ai` — waiting for AI; `done` — decided by matching.
  ADD COLUMN match_stage TEXT,
  ADD COLUMN match_group TEXT,
  ADD COLUMN match_source TEXT,
  -- The item the row is matched to or proposed for.
  ADD COLUMN item_id UUID REFERENCES catalog_item (id),
  -- [{itemId, score}] — up to three, the closest first.
  ADD COLUMN candidates JSONB,
  ADD COLUMN ai_proposed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ai_confidence NUMERIC(4, 3),
  ADD COLUMN ai_explanation TEXT,
  -- {code, rowNo}: why the row is where it is.
  ADD COLUMN match_note JSONB,
  -- {code, value}: an error found by matching (a repeated row, a service, the company's type).
  ADD COLUMN match_error JSONB,
  -- The supplier's decision.
  ADD COLUMN decision TEXT,
  ADD COLUMN decision_item_id UUID REFERENCES catalog_item (id),
  ADD COLUMN decided_by_member_id UUID REFERENCES supplier_member (id),
  ADD COLUMN decided_at TIMESTAMPTZ,
  ADD COLUMN price_confirmed BOOLEAN NOT NULL DEFAULT false,
  -- «Отправить администратору»: NULL — the default (on).
  ADD COLUMN send_request BOOLEAN,
  -- What applying did.
  ADD COLUMN outcome TEXT,
  ADD COLUMN outcome_reason TEXT,
  ADD COLUMN outcome_offer_id UUID REFERENCES offer (id),
  ADD CONSTRAINT price_import_row_match_key_check CHECK (
    match_key_kind IS NULL OR match_key_kind IN ('article', 'name')
  ),
  ADD CONSTRAINT price_import_row_match_stage_check CHECK (
    match_stage IS NULL OR match_stage IN ('ai', 'done')
  ),
  ADD CONSTRAINT price_import_row_match_group_check CHECK (
    match_group IS NULL OR match_group IN ('confident', 'review', 'not_found', 'error')
  ),
  ADD CONSTRAINT price_import_row_match_source_check CHECK (
    match_source IS NULL OR match_source IN (
      'mapping', 'exact_article', 'search', 'ai', 'remembered_skip', 'remembered_absent'
    )
  ),
  ADD CONSTRAINT price_import_row_decision_check CHECK (
    decision IS NULL OR decision IN ('accept', 'other', 'skip', 'not_in_catalog')
  ),
  ADD CONSTRAINT price_import_row_decided_check CHECK (
    (decision IS NULL) = (decided_at IS NULL)
  ),
  ADD CONSTRAINT price_import_row_outcome_check CHECK (
    outcome IS NULL OR outcome IN (
      'created', 'updated', 'unchanged', 'returned', 'withdrawn', 'requested', 'skipped',
      'not_applied'
    )
  );

-- The groups of the review, page by page.
CREATE INDEX price_import_row_group_idx ON price_import_row (import_id, match_group, row_no)
  WHERE kind = 'data';

-- What a company's rows were matched to: the item (`decision = 'item'`),
-- or that the supplier skipped the row (`skip`), or that the catalog has no
-- such item (`absent`). Found by the article (or the name without one).
CREATE TABLE supplier_sku_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  key_kind TEXT NOT NULL,
  key TEXT NOT NULL,
  decision TEXT NOT NULL,
  item_id UUID REFERENCES catalog_item (id),
  -- `supplier` — confirmed in a review; `admin` — the answer to a request;
  -- `auto` — the exact article and brand.
  confirmed_by TEXT NOT NULL,
  confirmed_by_member_id UUID REFERENCES supplier_member (id),
  confirmed_by_admin_id UUID REFERENCES admin_user (id),
  import_id UUID REFERENCES price_import (id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_sku_mapping_key_kind_check CHECK (key_kind IN ('article', 'name')),
  CONSTRAINT supplier_sku_mapping_decision_check CHECK (decision IN ('item', 'skip', 'absent')),
  CONSTRAINT supplier_sku_mapping_item_check CHECK ((decision = 'item') = (item_id IS NOT NULL)),
  CONSTRAINT supplier_sku_mapping_confirmed_by_check CHECK (
    confirmed_by IN ('supplier', 'admin', 'auto')
  ),
  CONSTRAINT supplier_sku_mapping_key_unique UNIQUE (supplier_id, key_kind, key)
);

CREATE INDEX supplier_sku_mapping_item_idx ON supplier_sku_mapping (item_id) WHERE item_id IS NOT NULL;

-- A request to add an item to the catalog (A-MOD-01): a row of a price list
-- the catalog has no item for. Only `new_item` so far.
CREATE TABLE catalog_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL DEFAULT 'new_item',
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  import_id UUID REFERENCES price_import (id),
  row_no INTEGER,
  key_kind TEXT NOT NULL,
  key TEXT NOT NULL,
  -- {article, brand, name, price, availability, leadDays}: what the row said.
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  result_item_id UUID REFERENCES catalog_item (id),
  reject_reason TEXT,
  created_by_member_id UUID REFERENCES supplier_member (id),
  decided_by_admin_id UUID REFERENCES admin_user (id),
  decided_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT catalog_request_type_check CHECK (type IN ('new_item')),
  CONSTRAINT catalog_request_key_kind_check CHECK (key_kind IN ('article', 'name')),
  CONSTRAINT catalog_request_status_check CHECK (status IN ('new', 'approved', 'rejected')),
  CONSTRAINT catalog_request_approved_check CHECK (
    (status = 'approved') = (result_item_id IS NOT NULL)
  ),
  CONSTRAINT catalog_request_rejected_check CHECK (
    (status = 'rejected') = (reject_reason IS NOT NULL)
  ),
  CONSTRAINT catalog_request_decided_check CHECK (
    (status = 'new') = (decided_at IS NULL AND decided_by_admin_id IS NULL)
  )
);

-- One open request per article (or name) of a company: the next price list
-- doesn't send it again.
CREATE UNIQUE INDEX catalog_request_open_key ON catalog_request (supplier_id, type, key_kind, key)
  WHERE status = 'new';
CREATE INDEX catalog_request_list_idx ON catalog_request (status, created_at DESC, id DESC);
CREATE INDEX catalog_request_supplier_idx ON catalog_request (supplier_id, created_at DESC, id DESC);

ALTER TABLE offer DROP CONSTRAINT offer_withdrawn_reason_check;
ALTER TABLE offer ADD CONSTRAINT offer_withdrawn_reason_check CHECK (
  withdrawn_reason IS NULL OR withdrawn_reason IN ('manual', 'missing_in_import', 'out_of_stock_in_import')
);

-- Down Migration
UPDATE offer SET withdrawn_reason = 'manual' WHERE withdrawn_reason = 'out_of_stock_in_import';
ALTER TABLE offer DROP CONSTRAINT offer_withdrawn_reason_check;
ALTER TABLE offer ADD CONSTRAINT offer_withdrawn_reason_check CHECK (
  withdrawn_reason IS NULL OR withdrawn_reason IN ('manual', 'missing_in_import')
);

DROP TABLE catalog_request;
DROP TABLE supplier_sku_mapping;

DROP INDEX price_import_row_group_idx;
ALTER TABLE price_import_row
  DROP COLUMN outcome_offer_id,
  DROP COLUMN outcome_reason,
  DROP COLUMN outcome,
  DROP COLUMN send_request,
  DROP COLUMN price_confirmed,
  DROP COLUMN decided_at,
  DROP COLUMN decided_by_member_id,
  DROP COLUMN decision_item_id,
  DROP COLUMN decision,
  DROP COLUMN match_error,
  DROP COLUMN match_note,
  DROP COLUMN ai_explanation,
  DROP COLUMN ai_confidence,
  DROP COLUMN ai_proposed,
  DROP COLUMN candidates,
  DROP COLUMN item_id,
  DROP COLUMN match_source,
  DROP COLUMN match_group,
  DROP COLUMN match_stage,
  DROP COLUMN match_key,
  DROP COLUMN match_key_kind;

DROP INDEX price_import_matching_idx;
DROP INDEX price_import_review_idx;
-- Matched, reviewed and applied imports read back as parsed ones; expired as failed.
UPDATE price_import SET status = 'parsed'
  WHERE status IN ('matching', 'review', 'applying', 'applied');
UPDATE price_import
  SET status = 'failed', failure = '{"reason":"timeout","detected":null,"limit":null,"line":null}'::jsonb
  WHERE status = 'expired';
ALTER TABLE price_import
  DROP CONSTRAINT price_import_applied_check,
  DROP CONSTRAINT price_import_missing_action_check,
  DROP COLUMN result,
  DROP COLUMN applied_at,
  DROP COLUMN applied_by_member_id,
  DROP COLUMN review_until,
  DROP COLUMN matched_at,
  DROP COLUMN changed_at,
  DROP COLUMN changed_by_member_id,
  DROP COLUMN missing_decided_at,
  DROP COLUMN missing_decided_by_member_id,
  DROP COLUMN missing_action;
ALTER TABLE price_import DROP CONSTRAINT price_import_status_check;
ALTER TABLE price_import ADD CONSTRAINT price_import_status_check CHECK (
  status IN ('parsing', 'columns', 'reading', 'parsed', 'failed')
);

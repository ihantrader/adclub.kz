-- Up Migration
-- The spot check of AI matches, hardened after acceptance (TASK-065.A;
-- ARCHITECTURE 4.94):
-- - a check keeps what its row did to the offer when applied
--   (`row_outcome`): «Неверно» withdraws only the offer the row made;
-- - an offer remembers the price list that made it (`created_import_id`;
--   `NULL` — by hand, or made before this column: not known, kept);
-- - an applied import keeps how many rows AI proposed and how many of them
--   the supplier accepted: the accuracy of a period adds imports up instead
--   of counting every row of every price list.

ALTER TABLE price_match_audit ADD COLUMN row_outcome TEXT;
ALTER TABLE price_match_audit ADD CONSTRAINT price_match_audit_row_outcome_check CHECK (
  row_outcome IS NULL OR row_outcome IN ('created', 'updated', 'unchanged', 'returned')
);
UPDATE price_match_audit a SET row_outcome = r.outcome
FROM price_import_row r
WHERE r.import_id = a.import_id AND r.row_no = a.row_no
  AND r.outcome IN ('created', 'updated', 'unchanged', 'returned');

ALTER TABLE offer ADD COLUMN created_import_id UUID REFERENCES price_import (id);

ALTER TABLE price_import
  ADD COLUMN ai_proposed_rows INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN ai_accepted_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE price_import ADD CONSTRAINT price_import_ai_rows_check CHECK (
  ai_proposed_rows >= 0 AND ai_accepted_rows >= 0 AND ai_accepted_rows <= ai_proposed_rows
);

-- Imports applied before: counted by portions of imports, never by one
-- statement over every row of every price list.
DO $$
DECLARE
  batch UUID[];
  last_id UUID := '00000000-0000-0000-0000-000000000000';
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id) INTO batch
    FROM (
      SELECT id FROM price_import
      WHERE status = 'applied' AND id > last_id
      ORDER BY id
      LIMIT 50
    ) next_imports;
    EXIT WHEN batch IS NULL;
    UPDATE price_import i
    SET ai_proposed_rows = c.proposed, ai_accepted_rows = c.accepted
    FROM (
      SELECT r.import_id, count(*)::int AS proposed,
        count(*) FILTER (
          WHERE r.decision = 'accept' AND r.decision_item_id = (r.candidates->0->>'itemId')::uuid
        )::int AS accepted
      FROM price_import_row r
      WHERE r.import_id = ANY(batch) AND r.ai_proposed
      GROUP BY r.import_id
    ) c
    WHERE i.id = c.import_id;
    last_id := batch[array_length(batch, 1)];
  END LOOP;
END $$;

-- The accuracy of a period: applied imports by the moment of applying.
CREATE INDEX price_import_applied_idx ON price_import (applied_at) WHERE status = 'applied';

-- Down Migration
DROP INDEX price_import_applied_idx;

ALTER TABLE price_import
  DROP CONSTRAINT price_import_ai_rows_check,
  DROP COLUMN ai_accepted_rows,
  DROP COLUMN ai_proposed_rows;

ALTER TABLE offer DROP COLUMN created_import_id;

ALTER TABLE price_match_audit
  DROP CONSTRAINT price_match_audit_row_outcome_check,
  DROP COLUMN row_outcome;

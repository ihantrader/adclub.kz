-- Up Migration
-- The review of a price list in the cabinet, «Модерация», requests by hand
-- and the cabinet's own export (TASK-048; ARCHITECTURE 12.4, 4.68).
--
-- 1. A row matched by the hidden `item_id` column of the cabinet's export
--    has its own source.
-- 2. A request to add an item comes from a price list or from the form
--    «Нет в справочнике? Отправьте запрос на добавление» (S-OFF-05, `manual`)
--    — with the subcategory the supplier thinks of and a comment.
-- 3. What an employee has seen of «Модерация»: the decisions made after the
--    moment they last opened it are «новое» for them.

ALTER TABLE price_import_row DROP CONSTRAINT price_import_row_match_source_check;
ALTER TABLE price_import_row ADD CONSTRAINT price_import_row_match_source_check CHECK (
  match_source IS NULL OR match_source IN (
    'mapping', 'exact_article', 'search', 'ai', 'remembered_skip', 'remembered_absent', 'item_id'
  )
);

ALTER TABLE catalog_request
  ADD COLUMN source TEXT NOT NULL DEFAULT 'price_import',
  ADD COLUMN category_id UUID REFERENCES category (id),
  ADD COLUMN comment TEXT,
  ADD CONSTRAINT catalog_request_source_check CHECK (source IN ('price_import', 'manual')),
  -- A request by hand belongs to no import; one from a price list always does.
  ADD CONSTRAINT catalog_request_import_check CHECK (
    (source = 'manual') = (import_id IS NULL)
  );

-- The requests one company sent by hand in the last day (the limit).
CREATE INDEX catalog_request_manual_idx ON catalog_request (supplier_id, created_at)
  WHERE source = 'manual';

-- The decisions of «Модерация» newer than this moment are «новое» for the
-- employee; `NULL` — never opened (from the moment they were added).
ALTER TABLE supplier_member ADD COLUMN moderation_seen_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE supplier_member DROP COLUMN moderation_seen_at;
DROP INDEX catalog_request_manual_idx;
DELETE FROM catalog_request WHERE source = 'manual';
ALTER TABLE catalog_request
  DROP CONSTRAINT catalog_request_import_check,
  DROP CONSTRAINT catalog_request_source_check,
  DROP COLUMN comment,
  DROP COLUMN category_id,
  DROP COLUMN source;
UPDATE price_import_row SET match_source = NULL WHERE match_source = 'item_id';
ALTER TABLE price_import_row DROP CONSTRAINT price_import_row_match_source_check;
ALTER TABLE price_import_row ADD CONSTRAINT price_import_row_match_source_check CHECK (
  match_source IS NULL OR match_source IN (
    'mapping', 'exact_article', 'search', 'ai', 'remembered_skip', 'remembered_absent'
  )
);

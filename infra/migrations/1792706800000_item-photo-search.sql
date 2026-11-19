-- Up Migration
-- Photos of items found by the image search and photos of suppliers
-- (TASK-068, D-076; ARCHITECTURE 4.95, 9.7; PRODUCT 7.6; SCREENS A-MOD-03,
-- S-OFF-03, S-OFF-05, S-MOD-01).
--
-- 1. A supplier's photo of a request to add an item (S-OFF-05) exists before
--    the item does: `item_photo` belongs to an item **or** to a request, and
--    when the administrator makes the item of the request, the photos move
--    to it as candidates (`item_id` is set, `catalog_request_id` stays as
--    where they came from).
-- 2. Who put a supplier's photo forward: the company and the employee.
-- 3. `digested_at` — the decision on a supplier's photo was counted by the
--    daily digest W-06 (ARCHITECTURE 4.89 I1029), like requests and
--    compatibility proposals.
-- 4. When the item was last searched for photos and how many times
--    (`photo_search_retry_days`), and the log of searches — the count of a
--    day for `photo_search_per_day`.

ALTER TABLE item_photo ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE item_photo ADD COLUMN catalog_request_id UUID REFERENCES catalog_request (id);
ALTER TABLE item_photo ADD COLUMN supplier_id UUID REFERENCES supplier (id);
ALTER TABLE item_photo ADD COLUMN supplier_member_id UUID REFERENCES supplier_member (id);
ALTER TABLE item_photo ADD COLUMN digested_at TIMESTAMPTZ;
ALTER TABLE item_photo ADD CONSTRAINT item_photo_owner_check CHECK (
  item_id IS NOT NULL OR catalog_request_id IS NOT NULL
);
-- A supplier's photo names its company; nothing else does.
ALTER TABLE item_photo ADD CONSTRAINT item_photo_supplier_check CHECK (
  (proposed_by = 'supplier') = (supplier_id IS NOT NULL)
  AND (supplier_member_id IS NULL OR supplier_id IS NOT NULL)
);
-- A candidate of the search always names the page it came from (the
-- source-type check already requires it for the three "found online" types).
ALTER TABLE item_photo ADD CONSTRAINT item_photo_ai_source_check CHECK (
  proposed_by <> 'ai' OR source_type IN ('manufacturer', 'official_catalog', 'multi_store')
);

-- The same picture is not sent twice with one request.
CREATE UNIQUE INDEX item_photo_request_checksum_key ON item_photo (catalog_request_id, checksum)
  WHERE item_id IS NULL AND removed_at IS NULL;
CREATE INDEX item_photo_request_idx ON item_photo (catalog_request_id)
  WHERE catalog_request_id IS NOT NULL;
-- The admin's queue (A-MOD-03): candidates of the search and photos of
-- suppliers on an item, oldest first.
CREATE INDEX item_photo_moderation_idx ON item_photo (created_at, id)
  WHERE status = 'proposed' AND proposed_by IN ('ai', 'supplier') AND item_id IS NOT NULL;
-- The company's photos: «Модерация» of the cabinet and the limit of a day.
CREATE INDEX item_photo_supplier_idx ON item_photo (supplier_id, created_at)
  WHERE supplier_id IS NOT NULL;
-- What the next digest W-06 takes.
CREATE INDEX item_photo_digest_idx ON item_photo (supplier_id)
  WHERE supplier_id IS NOT NULL AND reviewed_at IS NOT NULL AND digested_at IS NULL;

ALTER TABLE catalog_item ADD COLUMN photo_search_at TIMESTAMPTZ;
ALTER TABLE catalog_item ADD COLUMN photo_search_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog_item ADD CONSTRAINT catalog_item_photo_search_count_check CHECK (
  photo_search_count >= 0
);

-- One search for photos of one item: by the administrator's button or by
-- the background job. A row is written before the provider is called, so
-- the count of a day (`photo_search_per_day`) holds for searches in flight.
CREATE TABLE photo_search (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES catalog_item (id),
  trigger TEXT NOT NULL,
  requested_by UUID REFERENCES account (id),
  provider TEXT NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  -- What the provider returned, what the ranking kept, what was stored and
  -- what was dropped (other domains, broken files, private addresses…).
  results INTEGER,
  candidates INTEGER,
  skipped JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT photo_search_trigger_check CHECK (trigger IN ('admin', 'job')),
  CONSTRAINT photo_search_status_check CHECK (
    status IN ('running', 'done', 'unavailable', 'failed')
  ),
  CONSTRAINT photo_search_finished_check CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT photo_search_query_check CHECK (btrim(query) <> '' AND length(query) <= 300)
);
CREATE INDEX photo_search_created_idx ON photo_search (created_at);
CREATE INDEX photo_search_item_idx ON photo_search (item_id, created_at DESC);

-- Down Migration
DROP TABLE photo_search;
ALTER TABLE catalog_item DROP CONSTRAINT catalog_item_photo_search_count_check;
ALTER TABLE catalog_item DROP COLUMN photo_search_count;
ALTER TABLE catalog_item DROP COLUMN photo_search_at;
DROP INDEX item_photo_digest_idx;
DROP INDEX item_photo_supplier_idx;
DROP INDEX item_photo_moderation_idx;
DROP INDEX item_photo_request_idx;
DROP INDEX item_photo_request_checksum_key;
ALTER TABLE item_photo DROP CONSTRAINT item_photo_ai_source_check;
ALTER TABLE item_photo DROP CONSTRAINT item_photo_supplier_check;
ALTER TABLE item_photo DROP CONSTRAINT item_photo_owner_check;
DELETE FROM item_photo_file WHERE photo_id IN (SELECT id FROM item_photo WHERE item_id IS NULL);
DELETE FROM item_photo WHERE item_id IS NULL;
ALTER TABLE item_photo DROP COLUMN digested_at;
ALTER TABLE item_photo DROP COLUMN supplier_member_id;
ALTER TABLE item_photo DROP COLUMN supplier_id;
ALTER TABLE item_photo DROP COLUMN catalog_request_id;
ALTER TABLE item_photo ALTER COLUMN item_id SET NOT NULL;

-- Up Migration
-- The hourly photo search (`catalog.search-photos`) picks its items by
-- walking the products without a photo in the order they wait: never
-- searched first, then the ones searched longest ago, the older item first
-- (TASK-068.B; ARCHITECTURE 4.95). This index is that order, so a page of
-- the walk reads only its own rows and stops — whatever the size of the
-- catalog. `-infinity` stands for «never searched»: one comparable key, so
-- the walk continues after any row with a plain row comparison. Only
-- products that may be searched at all are in it: active, not a service,
-- without a primary photo.

CREATE INDEX catalog_item_photo_search_due_idx
  ON catalog_item ((coalesce(photo_search_at, '-infinity'::timestamptz)), created_at, id)
  WHERE status = 'active' AND item_type <> 'service' AND primary_photo_id IS NULL;

-- Down Migration
DROP INDEX catalog_item_photo_search_due_idx;

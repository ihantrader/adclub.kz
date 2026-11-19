-- Up Migration
-- The translation queue in the order of what matters to a buyer
-- (TASK-054; ARCHITECTURE 4.97): first the structure everyone sees
-- (categories, attributes, list options, titles of maintenance plans —
-- priority 0), then items with an offer on the showcase (1), then the other
-- items (2); within a group the task that waits longest first.
--
-- `priority` is set when the task is put on the queue and moved by the
-- minute job `catalog.translation-priority` when an item gains or loses its
-- offers on the showcase, so a run picks its batch from this index alone —
-- it never reads the offers of the catalog.

ALTER TABLE translation_task
  ADD COLUMN priority SMALLINT NOT NULL DEFAULT 2,
  ADD CONSTRAINT translation_task_priority_check CHECK (priority BETWEEN 0 AND 2);

-- Everything that is not an item is structure. Items wait at 2 until the
-- minute job finds their offers on the showcase.
UPDATE translation_task SET priority = 0 WHERE entity_type <> 'catalog_item';

-- What a run takes: the pending tasks in the order of the queue.
DROP INDEX translation_task_pending_idx;
CREATE INDEX translation_task_claim_idx ON translation_task (priority, updated_at, id)
  WHERE status = 'pending';

-- What the minute job walks, page by page: the items whose translation waits.
CREATE INDEX translation_task_pending_item_idx ON translation_task (entity_id)
  WHERE status = 'pending' AND entity_type = 'catalog_item';

-- Down Migration
DROP INDEX translation_task_pending_item_idx;
DROP INDEX translation_task_claim_idx;
CREATE INDEX translation_task_pending_idx ON translation_task (created_at)
  WHERE status = 'pending';
ALTER TABLE translation_task
  DROP CONSTRAINT translation_task_priority_check,
  DROP COLUMN priority;

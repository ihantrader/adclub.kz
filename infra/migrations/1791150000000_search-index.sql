-- Up Migration
-- The search index of the catalog (TASK-045; ARCHITECTURE 10.1–10.3, 4.65).
--
-- Meilisearch keeps a document per item users can find; PostgreSQL stays
-- the source of truth, and the index is rebuilt from it at any time. A
-- change of anything a document is made of registers itself in
-- `search_outbox` in the very transaction of the change — a rolled-back
-- change leaves no row — and the worker applies the rows in batches.
--
-- The one place a change is registered: the function
-- `search_outbox_register`, called by a trigger on every table a document
-- is made of. No service writes to the outbox by hand, so a new way of
-- changing those tables (an operator command, an import, a seed) cannot
-- forget it. A row names a subject — an item, a category, an option of a
-- list, a brand, a supplier, a point of a supplier — and the worker works
-- out which items it touches when it applies it.

CREATE TABLE search_outbox (
  id BIGSERIAL PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the worker applied it; kept a day for `search:reindex`, which
  -- applies again what changed while it rebuilt.
  processed_at TIMESTAMPTZ,
  CONSTRAINT search_outbox_subject_kind_check CHECK (
    subject_kind IN ('item', 'category', 'option', 'brand', 'supplier', 'location')
  )
);

CREATE INDEX search_outbox_pending_idx ON search_outbox (id) WHERE processed_at IS NULL;
CREATE INDEX search_outbox_processed_idx ON search_outbox (processed_at)
  WHERE processed_at IS NOT NULL;

-- One row: what the worker knows about the index.
CREATE TABLE search_index_state (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  -- The hash of the synonyms last put in the index settings.
  synonyms_hash TEXT,
  -- After the index failed to answer: no new attempt before this.
  retry_after TIMESTAMPTZ,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_applied_at TIMESTAMPTZ,
  -- A rebuild in progress (`search:reindex`): another one waits.
  reindex_started_at TIMESTAMPTZ,
  last_reindexed_at TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  last_reconcile_documents INTEGER,
  last_reconcile_mismatches INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT search_index_state_single_check CHECK (id = 1),
  CONSTRAINT search_index_state_failures_check CHECK (failures >= 0)
);

INSERT INTO search_index_state (id) VALUES (1);

-- The subjects a row of a table touches: the item of an offer, the
-- category of an attribute, the point of a closed date…
CREATE FUNCTION search_outbox_subjects(source TEXT, data JSONB)
  RETURNS TABLE (kind TEXT, subject UUID)
  LANGUAGE plpgsql IMMUTABLE
  AS $$
  BEGIN
    IF data IS NULL THEN
      RETURN;
    END IF;
    CASE source
      WHEN 'catalog_item' THEN
        kind := 'item'; subject := (data ->> 'id')::uuid;
      WHEN 'offer', 'item_attribute_value' THEN
        kind := 'item'; subject := (data ->> 'item_id')::uuid;
      WHEN 'translation' THEN
        IF data ->> 'field' <> 'name' THEN
          RETURN;
        END IF;
        subject := (data ->> 'entity_id')::uuid;
        kind := CASE data ->> 'entity_type'
          WHEN 'catalog_item' THEN 'item'
          WHEN 'category' THEN 'category'
          WHEN 'attribute_option' THEN 'option'
          ELSE NULL
        END;
      WHEN 'item_search_synonym' THEN
        IF data ->> 'item_id' IS NOT NULL THEN
          kind := 'item'; subject := (data ->> 'item_id')::uuid;
        ELSE
          kind := 'category'; subject := (data ->> 'category_id')::uuid;
        END IF;
      WHEN 'category' THEN
        kind := 'category'; subject := (data ->> 'id')::uuid;
      WHEN 'attribute' THEN
        kind := 'category'; subject := (data ->> 'category_id')::uuid;
      WHEN 'brand' THEN
        kind := 'brand'; subject := (data ->> 'id')::uuid;
      WHEN 'brand_spelling' THEN
        kind := 'brand'; subject := (data ->> 'brand_id')::uuid;
      WHEN 'supplier' THEN
        kind := 'supplier'; subject := (data ->> 'id')::uuid;
      WHEN 'supplier_location' THEN
        kind := 'location'; subject := (data ->> 'id')::uuid;
      WHEN 'supplier_closed_date' THEN
        kind := 'location'; subject := (data ->> 'location_id')::uuid;
      ELSE
        RETURN;
    END CASE;
    IF kind IS NOT NULL AND subject IS NOT NULL THEN
      RETURN NEXT;
    END IF;
  END;
  $$;

-- The one registration of a change: the subjects of the row before and
-- after, each once.
CREATE FUNCTION search_outbox_register(source TEXT, new_data JSONB, old_data JSONB)
  RETURNS void
  LANGUAGE sql
  AS $$
    INSERT INTO search_outbox (subject_kind, subject_id)
    SELECT DISTINCT s.kind, s.subject FROM (
      SELECT * FROM search_outbox_subjects(source, new_data)
      UNION
      SELECT * FROM search_outbox_subjects(source, old_data)
    ) s
  $$;

CREATE FUNCTION search_outbox_on_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    new_data JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
    old_data JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  BEGIN
    -- An update that changed nothing changes no document.
    IF TG_OP = 'UPDATE' AND new_data = old_data THEN
      RETURN NULL;
    END IF;
    PERFORM search_outbox_register(TG_TABLE_NAME, new_data, old_data);
    RETURN NULL;
  END;
  $$;

CREATE TRIGGER catalog_item_search_outbox AFTER INSERT OR UPDATE OR DELETE ON catalog_item
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER offer_search_outbox AFTER INSERT OR UPDATE OR DELETE ON offer
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER item_attribute_value_search_outbox
  AFTER INSERT OR UPDATE OR DELETE ON item_attribute_value
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER translation_search_outbox AFTER INSERT OR UPDATE OR DELETE ON translation
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER item_search_synonym_search_outbox
  AFTER INSERT OR UPDATE OR DELETE ON item_search_synonym
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER category_search_outbox AFTER INSERT OR UPDATE OR DELETE ON category
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER attribute_search_outbox AFTER INSERT OR UPDATE OR DELETE ON attribute
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER brand_search_outbox AFTER INSERT OR UPDATE OR DELETE ON brand
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER brand_spelling_search_outbox AFTER INSERT OR UPDATE OR DELETE ON brand_spelling
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER supplier_search_outbox AFTER INSERT OR UPDATE OR DELETE ON supplier
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER supplier_location_search_outbox
  AFTER INSERT OR UPDATE OR DELETE ON supplier_location
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();
CREATE TRIGGER supplier_closed_date_search_outbox
  AFTER INSERT OR UPDATE OR DELETE ON supplier_closed_date
  FOR EACH ROW EXECUTE FUNCTION search_outbox_on_change();

-- Down Migration
DROP TRIGGER supplier_closed_date_search_outbox ON supplier_closed_date;
DROP TRIGGER supplier_location_search_outbox ON supplier_location;
DROP TRIGGER supplier_search_outbox ON supplier;
DROP TRIGGER brand_spelling_search_outbox ON brand_spelling;
DROP TRIGGER brand_search_outbox ON brand;
DROP TRIGGER attribute_search_outbox ON attribute;
DROP TRIGGER category_search_outbox ON category;
DROP TRIGGER item_search_synonym_search_outbox ON item_search_synonym;
DROP TRIGGER translation_search_outbox ON translation;
DROP TRIGGER item_attribute_value_search_outbox ON item_attribute_value;
DROP TRIGGER offer_search_outbox ON offer;
DROP TRIGGER catalog_item_search_outbox ON catalog_item;
DROP FUNCTION search_outbox_on_change();
DROP FUNCTION search_outbox_register(TEXT, JSONB, JSONB);
DROP FUNCTION search_outbox_subjects(TEXT, JSONB);
DROP TABLE search_index_state;
DROP TABLE search_outbox;

-- Up Migration
-- Items of the catalog (ARCHITECTURE.md 5.2, 4.17; TASK-011): brands with
-- their spellings, items of three types (a part by its article, a product
-- by its attributes, a service), their attribute values and analogs.
-- Nothing here is ever deleted except an analog link the administrator
-- removes: offers, requests and history will point at items and brands, so
-- "delete" is archiving.

-- A brand of a manufacturer. Its name and other spellings live in
-- `brand_spelling`, where one unique key holds them all.
CREATE TABLE brand (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  is_oem BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT brand_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT brand_archived_at_check CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT brand_version_check CHECK (version > 0)
);

-- The name of a brand (`is_name`, exactly one per brand) and its other
-- spellings (`Geely`, `GEELY Auto`). `key` is the spelling without case and
-- whitespace: one spelling can't belong to two brands — archived ones
-- included — whatever the case or spaces, and the database holds it.
CREATE TABLE brand_spelling (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID NOT NULL REFERENCES brand (id),
  text TEXT NOT NULL,
  key TEXT NOT NULL,
  is_name BOOLEAN NOT NULL,
  CONSTRAINT brand_spelling_key_key UNIQUE (key),
  CONSTRAINT brand_spelling_text_check CHECK (btrim(text) <> ''),
  CONSTRAINT brand_spelling_key_check CHECK (key <> '' AND key !~ '\s' AND key = lower(key))
);

CREATE UNIQUE INDEX brand_spelling_name_key ON brand_spelling (brand_id) WHERE is_name;
CREATE INDEX brand_spelling_brand_idx ON brand_spelling (brand_id);

-- An item of the catalog.
-- - `part`: a brand and its article (the key of a part, PRODUCT 7.3);
-- - `generic`: a brand and attributes (engine oil: viscosity, approval,
--   volume); an article is optional;
-- - `service`: neither brand nor article.
-- The type never changes (trigger below). `category_kind` and
-- `category_level` make the foreign key accept only a subcategory of the
-- right kind: goods for parts and products, services for services.
-- `article_norm` is `normalizeArticle(article)` (packages/domain): one
-- article of one brand is one item, whatever its type — the partial unique
-- index holds it. `completeness` follows the data (ARCHITECTURE 4.17):
-- `incomplete` while an active attribute of the category that counts for
-- completeness has no value.
CREATE TABLE catalog_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type TEXT NOT NULL,
  category_id UUID NOT NULL,
  category_kind TEXT NOT NULL,
  category_level SMALLINT NOT NULL DEFAULT 2,
  brand_id UUID REFERENCES brand (id),
  article TEXT,
  article_norm TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  completeness TEXT NOT NULL DEFAULT 'complete',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT catalog_item_category_fkey FOREIGN KEY (category_id, category_kind, category_level)
    REFERENCES category (id, kind, level),
  -- The analogs' foreign keys point here: both items of a link are parts
  -- of one subcategory.
  CONSTRAINT catalog_item_id_category_type_key UNIQUE (id, category_id, item_type),
  CONSTRAINT catalog_item_type_check CHECK (item_type IN ('part', 'generic', 'service')),
  CONSTRAINT catalog_item_category_level_check CHECK (category_level = 2),
  CONSTRAINT catalog_item_category_kind_check CHECK (
    (item_type = 'service') = (category_kind = 'services')
  ),
  CONSTRAINT catalog_item_brand_check CHECK ((item_type = 'service') = (brand_id IS NULL)),
  CONSTRAINT catalog_item_article_check CHECK (
    (article IS NULL) = (article_norm IS NULL)
    AND (article IS NULL OR (btrim(article) <> '' AND article_norm <> ''))
    AND (item_type <> 'part' OR article IS NOT NULL)
    AND (item_type <> 'service' OR article IS NULL)
  ),
  CONSTRAINT catalog_item_status_check CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT catalog_item_archived_at_check CHECK (
    (status = 'archived') = (archived_at IS NOT NULL)
  ),
  CONSTRAINT catalog_item_completeness_check CHECK (completeness IN ('complete', 'incomplete')),
  CONSTRAINT catalog_item_version_check CHECK (version > 0)
);

-- One article of one brand — one item (the database holds it; TASK-011 AC-3).
CREATE UNIQUE INDEX catalog_item_brand_article_key ON catalog_item (brand_id, article_norm)
  WHERE article_norm IS NOT NULL;
-- The admin list: newest first, and by category or brand.
CREATE INDEX catalog_item_created_idx ON catalog_item (created_at DESC, id DESC);
CREATE INDEX catalog_item_category_idx ON catalog_item (category_id, created_at DESC, id DESC);
CREATE INDEX catalog_item_brand_idx ON catalog_item (brand_id);
-- An exact or leading-part article lookup without the brand.
CREATE INDEX catalog_item_article_norm_idx ON catalog_item (article_norm text_pattern_ops)
  WHERE article_norm IS NOT NULL;

CREATE FUNCTION catalog_item_type_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_type IS DISTINCT FROM OLD.item_type THEN
    RAISE EXCEPTION 'catalog_item.item_type never changes';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalog_item_type_immutable
  BEFORE UPDATE ON catalog_item
  FOR EACH ROW EXECUTE FUNCTION catalog_item_type_immutable();

-- An option names its attribute, so a value can refer to both at once.
ALTER TABLE attribute_option
  ADD CONSTRAINT attribute_option_id_attribute_key UNIQUE (id, attribute_id);

-- The value of one attribute of one item, in the column of the attribute's
-- type; no row — an empty value. `attribute_value_type` makes the foreign
-- key check the type, and an option must be one of that very attribute.
-- A value of an attribute of another category (the item was moved) is
-- kept and ignored: it doesn't show and doesn't count (ARCHITECTURE 4.17).
-- `source`: who wrote it — the administrator; import and AI arrive later.
CREATE TABLE item_attribute_value (
  item_id UUID NOT NULL REFERENCES catalog_item (id),
  attribute_id UUID NOT NULL,
  attribute_value_type TEXT NOT NULL,
  value_num NUMERIC,
  value_option_id UUID,
  value_bool BOOLEAN,
  value_text TEXT,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, attribute_id),
  CONSTRAINT item_attribute_value_attribute_fkey FOREIGN KEY (attribute_id, attribute_value_type)
    REFERENCES attribute (id, value_type),
  CONSTRAINT item_attribute_value_option_fkey FOREIGN KEY (value_option_id, attribute_id)
    REFERENCES attribute_option (id, attribute_id),
  CONSTRAINT item_attribute_value_typed_check CHECK (
    (attribute_value_type = 'number' AND value_num IS NOT NULL AND value_option_id IS NULL
      AND value_bool IS NULL AND value_text IS NULL)
    OR (attribute_value_type = 'enum' AND value_option_id IS NOT NULL AND value_num IS NULL
      AND value_bool IS NULL AND value_text IS NULL)
    OR (attribute_value_type = 'bool' AND value_bool IS NOT NULL AND value_num IS NULL
      AND value_option_id IS NULL AND value_text IS NULL)
    OR (attribute_value_type = 'text' AND value_text IS NOT NULL AND btrim(value_text) <> ''
      AND value_num IS NULL AND value_option_id IS NULL AND value_bool IS NULL)
  ),
  CONSTRAINT item_attribute_value_source_check CHECK (source IN ('admin', 'import', 'ai'))
);

CREATE INDEX item_attribute_value_attribute_idx ON item_attribute_value (attribute_id);

-- Two items that are analogs of each other: one row per pair, the smaller
-- id first, so the link is symmetric, never with itself and never twice.
-- Both are parts of the same subcategory (`category_id` is shared by both
-- foreign keys): an item with analogs can't move to another category until
-- its links are removed. `status`: `approved` — shown next to the
-- original; `proposed` — a link suggested by a supplier or AI awaiting
-- review (EPIC-07 and moderation). `source`: who suggested it.
CREATE TABLE item_analog (
  item_id UUID NOT NULL,
  analog_item_id UUID NOT NULL,
  category_id UUID NOT NULL,
  item_type TEXT NOT NULL DEFAULT 'part',
  relation TEXT NOT NULL DEFAULT 'analog_of',
  status TEXT NOT NULL DEFAULT 'approved',
  source TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, analog_item_id),
  CONSTRAINT item_analog_item_fkey FOREIGN KEY (item_id, category_id, item_type)
    REFERENCES catalog_item (id, category_id, item_type),
  CONSTRAINT item_analog_analog_fkey FOREIGN KEY (analog_item_id, category_id, item_type)
    REFERENCES catalog_item (id, category_id, item_type),
  CONSTRAINT item_analog_order_check CHECK (item_id < analog_item_id),
  CONSTRAINT item_analog_type_check CHECK (item_type = 'part'),
  CONSTRAINT item_analog_relation_check CHECK (relation IN ('analog_of')),
  CONSTRAINT item_analog_status_check CHECK (status IN ('proposed', 'approved')),
  CONSTRAINT item_analog_source_check CHECK (source IN ('admin', 'supplier', 'ai'))
);

CREATE INDEX item_analog_analog_idx ON item_analog (analog_item_id);

-- Names of items in kk/ru/en join the shared translations (5.4).
ALTER TABLE translation DROP CONSTRAINT translation_entity_type_check;
ALTER TABLE translation ADD CONSTRAINT translation_entity_type_check CHECK (
  entity_type IN ('category', 'attribute', 'attribute_option', 'catalog_item')
);

-- Down Migration
DELETE FROM translation WHERE entity_type = 'catalog_item';
ALTER TABLE translation DROP CONSTRAINT translation_entity_type_check;
ALTER TABLE translation ADD CONSTRAINT translation_entity_type_check CHECK (
  entity_type IN ('category', 'attribute', 'attribute_option')
);
DROP TABLE item_analog;
DROP TABLE item_attribute_value;
ALTER TABLE attribute_option DROP CONSTRAINT attribute_option_id_attribute_key;
DROP TRIGGER catalog_item_type_immutable ON catalog_item;
DROP FUNCTION catalog_item_type_immutable();
DROP TABLE catalog_item;
DROP TABLE brand_spelling;
DROP TABLE brand;

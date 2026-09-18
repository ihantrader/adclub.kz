-- Up Migration
-- The structure of the catalog (ARCHITECTURE.md 5.2, 5.4, 4.15; TASK-010):
-- two-level categories of goods and services, the attributes of a
-- subcategory and the options of a list attribute, and their names in
-- kk/ru/en. Nothing here is ever deleted: items, orders and history will
-- point at these rows, so "delete" is archiving.

-- A category of the first level (a node: brakes, engine) or of the second
-- (a subcategory: brake pads). The two levels are held by the database
-- itself: a subcategory's (parent_id, kind, parent_level) must name a row
-- whose (id, kind, level) is (parent_id, kind, 1) — a parent of the same
-- kind on the first level. A node with subcategories can't change its kind
-- or level (the children's foreign key refuses), so a third level can't be
-- written even bypassing the application.
CREATE TABLE category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  level SMALLINT NOT NULL,
  parent_id UUID,
  parent_level SMALLINT,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  icon TEXT,
  compatibility_required BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT category_code_key UNIQUE (code),
  CONSTRAINT category_id_kind_level_key UNIQUE (id, kind, level),
  CONSTRAINT category_id_level_key UNIQUE (id, level),
  CONSTRAINT category_parent_fkey FOREIGN KEY (parent_id, kind, parent_level)
    REFERENCES category (id, kind, level),
  CONSTRAINT category_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT category_kind_check CHECK (kind IN ('goods', 'services')),
  CONSTRAINT category_level_check CHECK (
    (level = 1 AND parent_id IS NULL AND parent_level IS NULL)
    OR (level = 2 AND parent_id IS NOT NULL AND parent_level = 1)
  ),
  CONSTRAINT category_status_check CHECK (status IN ('active', 'hidden', 'archived')),
  CONSTRAINT category_archived_at_check CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT category_icon_check CHECK (icon IS NULL OR icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- D-029: only a subcategory of goods can require compatibility.
  CONSTRAINT category_compatibility_check CHECK (
    NOT compatibility_required OR (kind = 'goods' AND level = 2)
  ),
  CONSTRAINT category_version_check CHECK (version > 0)
);

CREATE INDEX category_parent_idx ON category (parent_id, sort);

-- An attribute of a subcategory. `category_level` is always 2, so the
-- foreign key only accepts a subcategory. The value type and the category
-- never change after creation (items will store values of that type):
-- the trigger below refuses it whatever the caller.
CREATE TABLE attribute (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL,
  category_level SMALLINT NOT NULL DEFAULT 2,
  code TEXT NOT NULL,
  value_type TEXT NOT NULL,
  number_integer BOOLEAN,
  number_min NUMERIC,
  number_max NUMERIC,
  is_filterable BOOLEAN NOT NULL DEFAULT false,
  is_required_for_complete BOOLEAN NOT NULL DEFAULT false,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attribute_category_fkey FOREIGN KEY (category_id, category_level)
    REFERENCES category (id, level),
  CONSTRAINT attribute_category_code_key UNIQUE (category_id, code),
  CONSTRAINT attribute_id_value_type_key UNIQUE (id, value_type),
  CONSTRAINT attribute_category_level_check CHECK (category_level = 2),
  CONSTRAINT attribute_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT attribute_value_type_check CHECK (value_type IN ('number', 'enum', 'bool', 'text')),
  CONSTRAINT attribute_number_check CHECK (
    (value_type = 'number' AND number_integer IS NOT NULL)
    OR (value_type <> 'number' AND number_integer IS NULL AND number_min IS NULL AND number_max IS NULL)
  ),
  CONSTRAINT attribute_number_range_check CHECK (
    number_min IS NULL OR number_max IS NULL OR number_min <= number_max
  ),
  -- A text is never a filter (TASK-010, SCREENS A-CAT-02).
  CONSTRAINT attribute_filterable_check CHECK (NOT (is_filterable AND value_type = 'text')),
  CONSTRAINT attribute_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT attribute_archived_at_check CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT attribute_version_check CHECK (version > 0)
);

CREATE INDEX attribute_category_idx ON attribute (category_id, sort);

CREATE FUNCTION attribute_identity_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.value_type IS DISTINCT FROM OLD.value_type THEN
    RAISE EXCEPTION 'attribute.value_type never changes (archive the attribute and create a new one)';
  END IF;
  IF NEW.category_id IS DISTINCT FROM OLD.category_id THEN
    RAISE EXCEPTION 'attribute.category_id never changes';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER attribute_identity_immutable
  BEFORE UPDATE ON attribute
  FOR EACH ROW EXECUTE FUNCTION attribute_identity_immutable();

-- An option of a list attribute: the foreign key only accepts an attribute
-- whose value type is `enum`.
CREATE TABLE attribute_option (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribute_id UUID NOT NULL,
  attribute_value_type TEXT NOT NULL DEFAULT 'enum',
  code TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attribute_option_attribute_fkey FOREIGN KEY (attribute_id, attribute_value_type)
    REFERENCES attribute (id, value_type),
  CONSTRAINT attribute_option_attribute_code_key UNIQUE (attribute_id, code),
  CONSTRAINT attribute_option_value_type_check CHECK (attribute_value_type = 'enum'),
  CONSTRAINT attribute_option_code_check CHECK (code ~ '^[a-z0-9][a-z0-9_]{0,62}$'),
  CONSTRAINT attribute_option_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT attribute_option_archived_at_check CHECK (
    (status = 'archived') = (archived_at IS NOT NULL)
  ),
  CONSTRAINT attribute_option_version_check CHECK (version > 0)
);

CREATE INDEX attribute_option_attribute_idx ON attribute_option (attribute_id, sort);

-- Texts of reference data in kk/ru/en (ARCHITECTURE 5.4): the model
-- TASK-012 builds automatic translation on. One row per entity, field and
-- language; a missing row is a missing translation (the client gets the
-- source language). `origin`: `source` — the text the administrator wrote
-- in the source language (Russian); `manual` — a translation the
-- administrator wrote; `ai` — an automatic translation (TASK-012). A
-- manually edited row is never overwritten by automatic translation.
-- `source_hash` — SHA-256 of the source text a translation was made from:
-- when the source changes, TASK-012 flags the translation as possibly
-- outdated. `entity_id` has no foreign key (several entity types share
-- the table); catalog rows are never deleted.
CREATE TABLE translation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  field TEXT NOT NULL,
  lang TEXT NOT NULL,
  text TEXT NOT NULL,
  origin TEXT NOT NULL,
  is_manually_edited BOOLEAN NOT NULL,
  source_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT translation_entity_field_lang_key UNIQUE (entity_type, entity_id, field, lang),
  CONSTRAINT translation_entity_type_check CHECK (
    entity_type IN ('category', 'attribute', 'attribute_option')
  ),
  CONSTRAINT translation_field_check CHECK (field IN ('name', 'unit')),
  CONSTRAINT translation_lang_check CHECK (lang IN ('kk', 'ru', 'en')),
  CONSTRAINT translation_text_check CHECK (btrim(text) <> ''),
  CONSTRAINT translation_origin_check CHECK (origin IN ('source', 'manual', 'ai')),
  CONSTRAINT translation_manual_check CHECK (origin <> 'manual' OR is_manually_edited),
  CONSTRAINT translation_source_hash_check CHECK (origin = 'source' OR source_hash IS NOT NULL)
);

-- One source text per entity and field.
CREATE UNIQUE INDEX translation_source_key ON translation (entity_type, entity_id, field)
  WHERE origin = 'source';

-- Down Migration
DROP TABLE translation;
DROP TABLE attribute_option;
DROP TRIGGER attribute_identity_immutable ON attribute;
DROP FUNCTION attribute_identity_immutable();
DROP TABLE attribute;
DROP TABLE category;

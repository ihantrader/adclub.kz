-- Up Migration
-- The search of the catalog for users (TASK-044; PRODUCT 7, 8.1, 8.2;
-- ARCHITECTURE 10.2, 4.64; SCREENS M-CAT-04).
--
-- Two forms of a text, the same as `normalizeSearchText` and `searchKey` of
-- `@adclub/domain` compute (the integration test compares them):
--
-- - `search_text` — lower case, `ё → е`, every character that is not a
--   digit or a Latin, Russian or Kazakh letter a space, spaces collapsed.
--   Upper-case Cyrillic is lowered by `translate` as well as by `lower()`,
--   so the result does not depend on the database's locale;
-- - `search_key` — the same with the Kazakh letters folded into the Russian
--   ones a person types without a Kazakh keyboard (`ә → а`, `қ → к`, `і → и`…).
--
-- `pg_trgm` — the similarity of words, for the correction of a query with a
-- typo or a mistyped letter («лолодки» → «колодки»), and the index that
-- finds names by the beginnings of their words. The extension is trusted:
-- the owner of the database installs it without a superuser.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE FUNCTION search_text(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT btrim(regexp_replace(
      translate(
        lower(value),
        'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯӘҒҚҢӨҰҮҺІё',
        'абвгдеежзийклмнопрстуфхцчшщъыьэюяәғқңөұүһіе'
      ),
      '[^0-9a-zа-яәғқңөұүһі]+', ' ', 'g'
    ))
  $$;

CREATE FUNCTION search_key(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT translate(search_text(value), 'әғқңөұүһі', 'агкноуухи')
  $$;

-- Names of items and categories by the beginnings of their words:
-- `(' ' || search_key(text)) LIKE '% колодк%'`.
CREATE INDEX translation_name_search_trgm ON translation
  USING gin ((' ' || search_key(text)) gin_trgm_ops)
  WHERE field = 'name';

-- Search synonyms (ARCHITECTURE 5.2 `item_search_synonym`, 10.2 п. 4): of an
-- item or of a category — of a node they find the items of its
-- subcategories. `lang` is for the administrator's reading only: a synonym
-- is searched in every language. Two synonyms of one owner never read the
-- same (`term_key`); one equal to a name is allowed.
CREATE TABLE item_search_synonym (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid REFERENCES catalog_item (id) ON DELETE CASCADE,
  category_id uuid REFERENCES category (id) ON DELETE CASCADE,
  lang text,
  term text NOT NULL,
  term_key text GENERATED ALWAYS AS (search_key(term)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_search_synonym_owner_check CHECK ((item_id IS NULL) <> (category_id IS NULL)),
  CONSTRAINT item_search_synonym_lang_check CHECK (lang IN ('kk', 'ru', 'en')),
  CONSTRAINT item_search_synonym_term_check
    CHECK (term = btrim(term) AND char_length(term) BETWEEN 2 AND 100 AND search_key(term) <> '')
);

CREATE UNIQUE INDEX item_search_synonym_item_key
  ON item_search_synonym (item_id, term_key) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX item_search_synonym_category_key
  ON item_search_synonym (category_id, term_key) WHERE category_id IS NOT NULL;

-- Down Migration
DROP TABLE item_search_synonym;
DROP INDEX translation_name_search_trgm;
DROP FUNCTION search_key(text);
DROP FUNCTION search_text(text);
DROP EXTENSION IF EXISTS pg_trgm;

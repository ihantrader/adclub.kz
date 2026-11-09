-- Up Migration
-- A dump of the database restores (TASK-055, found by the first restore
-- check): pg_restore runs with an empty search_path, so `search_key` — used
-- by generated columns, indexes and checks — could not find `search_text`,
-- and the restore stopped at the first table that uses it. The call names
-- its schema now; the function stays plain SQL, so it is still inlined.

CREATE OR REPLACE FUNCTION search_key(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT translate(public.search_text(value), 'әғқңөұүһі', 'агкноуухи')
  $$;

-- Down Migration
CREATE OR REPLACE FUNCTION search_key(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
    SELECT translate(search_text(value), 'әғқңөұүһі', 'агкноуухи')
  $$;

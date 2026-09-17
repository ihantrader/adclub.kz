-- Up Migration
-- Settings in data (ARCHITECTURE.md 5.12, 14, 4.11; TASK-007). The registry
-- in code describes every setting and its default; only changed values are
-- stored here, and every change is recorded in the history.

-- The changed values in effect. A reset deletes the row. `version` is the
-- setting's version the value was written at (see app_setting_change).
CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  version INTEGER NOT NULL,
  updated_by_kind TEXT NOT NULL,
  updated_by_admin_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_setting_key_check CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT app_setting_version_check CHECK (version > 0),
  CONSTRAINT app_setting_updated_by_check CHECK (
    (updated_by_kind = 'admin' AND updated_by_admin_id IS NOT NULL)
    OR (updated_by_kind = 'operator' AND updated_by_admin_id IS NULL)
  )
);

-- Every change and reset, never edited: who (an administrator or the
-- operator command), when, the value in effect before and after, and why.
-- The key's current version is its latest entry here (0 without any), so
-- versions survive resets. Actor ids have no foreign keys: the history
-- outlives the accounts it mentions (TASK-009 moves it into audit_log).
CREATE TABLE app_setting_change (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  previous_value JSONB NOT NULL,
  previous_is_default BOOLEAN NOT NULL,
  new_value JSONB NOT NULL,
  new_is_default BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_admin_id UUID,
  actor_account_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_setting_change_key_version_key UNIQUE (key, version),
  CONSTRAINT app_setting_change_version_check CHECK (version > 0),
  CONSTRAINT app_setting_change_action_check CHECK (action IN ('set', 'reset')),
  CONSTRAINT app_setting_change_reason_check CHECK (btrim(reason) <> ''),
  CONSTRAINT app_setting_change_actor_check CHECK (
    (actor_kind = 'admin' AND actor_admin_id IS NOT NULL AND actor_account_id IS NOT NULL)
    OR (actor_kind = 'operator' AND actor_admin_id IS NULL AND actor_account_id IS NULL)
  )
);

CREATE INDEX app_setting_change_key_idx ON app_setting_change (key, version DESC);

-- The history is append-only: UPDATE and DELETE are refused whatever the
-- caller (TRUNCATE, used by tests, is not a row operation).
CREATE FUNCTION app_setting_change_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'app_setting_change is append-only';
END;
$$;

CREATE TRIGGER app_setting_change_immutable
  BEFORE UPDATE OR DELETE ON app_setting_change
  FOR EACH ROW EXECUTE FUNCTION app_setting_change_immutable();

-- Down Migration
DROP TABLE app_setting_change;
DROP FUNCTION app_setting_change_immutable();
DROP TABLE app_setting;

-- Up Migration
-- The action journal (ARCHITECTURE.md 5.12, 15.3; TASK-009). Significant
-- actions of people: an administrator, a supplier employee, a user changing
-- someone else's data or rights, and the server operator command. Written in
-- the same transaction as the action itself, so there is no action without
-- an entry and no entry without an action. Personal data in `before`/`after`
-- is kept as it is — this is the database in Kazakhstan, not monitoring
-- (PRODUCT 17); it leaves only through the admin API.
--
-- Kept for at least 12 months; cleaning and archiving come later (not in
-- TASK-009), so nothing deletes from this table yet.
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  -- Who acted. `operator` is the server command (no account at all),
  -- `system` is the platform itself (a scheduled job).
  actor_role TEXT NOT NULL,
  actor_account_id UUID,
  actor_admin_id UUID,
  actor_supplier_id UUID,
  actor_member_id UUID,
  entity_type TEXT NOT NULL,
  -- Not a UUID column: an entity is also a setting key or a job name.
  entity_id TEXT NOT NULL,
  before JSONB,
  after JSONB,
  reason TEXT,
  ip TEXT,
  user_agent TEXT,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_action_check CHECK (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  CONSTRAINT audit_log_entity_type_check CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT audit_log_entity_id_check CHECK (btrim(entity_id) <> ''),
  -- Actor ids have no foreign keys: the journal outlives the accounts,
  -- administrators and companies it mentions.
  CONSTRAINT audit_log_actor_check CHECK (
    (actor_role = 'admin'
      AND actor_account_id IS NOT NULL AND actor_admin_id IS NOT NULL
      AND actor_supplier_id IS NULL AND actor_member_id IS NULL)
    OR (actor_role = 'supplier'
      AND actor_account_id IS NOT NULL AND actor_supplier_id IS NOT NULL
      AND actor_member_id IS NOT NULL AND actor_admin_id IS NULL)
    OR (actor_role = 'user'
      AND actor_account_id IS NOT NULL AND actor_admin_id IS NULL
      AND actor_supplier_id IS NULL AND actor_member_id IS NULL)
    OR (actor_role IN ('operator', 'system')
      AND actor_account_id IS NULL AND actor_admin_id IS NULL
      AND actor_supplier_id IS NULL AND actor_member_id IS NULL)
  )
);

-- The admin panel reads the journal newest first, with filters (TASK-034);
-- paging is by (created_at, id), so that pair is the order of every index.
CREATE INDEX audit_log_created_at_idx ON audit_log (created_at DESC, id DESC);
CREATE INDEX audit_log_action_idx ON audit_log (action, created_at DESC, id DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_account_id, created_at DESC, id DESC)
  WHERE actor_account_id IS NOT NULL;

-- Append-only: UPDATE and DELETE are refused whatever the caller, so an
-- entry can't be changed or removed through the application (TRUNCATE, used
-- by tests, is not a row operation).
CREATE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Down Migration
DROP TABLE audit_log;
DROP FUNCTION audit_log_immutable();

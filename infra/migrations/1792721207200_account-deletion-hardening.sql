-- Up Migration
-- Deleting the account, hardened (TASK-072.A; ARCHITECTURE 4.96):
-- - the deletion finds the journal's entries about the account and the
--   gateway's rows of its number through indexes: its cost follows what the
--   account itself left, not the size of `audit_log`, `outbound_message`
--   and `message_button_press` (they only grow, the statement limit is 2 s).
--   The journal indexes are partial: only entries that name an account in
--   `before`/`after` get an index entry;
-- - the redaction flag of the journal (`adclub.audit_redaction`) lets an
--   update only take top-level keys out of `before`/`after`: every key left
--   keeps its value, nothing is added or rewritten;
-- - a message being sent when its recipient deleted the account
--   (`erase_phone`) loses the number and the values as soon as the attempt
--   settles it, whichever path settles it (a retry is cancelled instead).

CREATE INDEX audit_log_before_account_idx ON audit_log ((before ->> 'accountId'))
  WHERE (before ->> 'accountId') IS NOT NULL;
CREATE INDEX audit_log_after_account_idx ON audit_log ((after ->> 'accountId'))
  WHERE (after ->> 'accountId') IS NOT NULL;
CREATE INDEX message_button_press_from_phone_idx ON message_button_press (from_phone);
CREATE INDEX sign_in_step_account_idx ON sign_in_step (account_id);

-- `new` keeps only keys of `old`, each with the value it had there.
CREATE OR REPLACE FUNCTION audit_jsonb_only_removed(old jsonb, new jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN new IS NOT DISTINCT FROM old THEN true
    WHEN old IS NULL OR new IS NULL THEN false
    WHEN jsonb_typeof(old) <> 'object' OR jsonb_typeof(new) <> 'object' THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_each(new) AS kept
      WHERE NOT (old ? kept.key) OR (old -> kept.key) IS DISTINCT FROM kept.value
    )
  END
$$;

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('adclub.audit_redaction', true) = 'on'
     AND (to_jsonb(NEW) - 'before' - 'after') = (to_jsonb(OLD) - 'before' - 'after')
     AND audit_jsonb_only_removed(OLD.before, NEW.before)
     AND audit_jsonb_only_removed(OLD.after, NEW.after) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

ALTER TABLE outbound_message ADD COLUMN erase_phone BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION outbound_message_erase_phone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.erase_phone AND NEW.status <> 'sending' THEN
    IF NEW.status = 'queued' THEN
      NEW.status := 'cancelled';
      NEW.settled_at := COALESCE(NEW.settled_at, now());
    END IF;
    NEW.phone := '+70000000000';
    NEW.variables := NULL;
    NEW.erase_phone := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_message_erase_phone
  BEFORE UPDATE ON outbound_message
  FOR EACH ROW WHEN (NEW.erase_phone)
  EXECUTE FUNCTION outbound_message_erase_phone();

-- Down Migration
DROP TRIGGER outbound_message_erase_phone ON outbound_message;
DROP FUNCTION outbound_message_erase_phone();
ALTER TABLE outbound_message DROP COLUMN erase_phone;
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('adclub.audit_redaction', true) = 'on'
     AND (to_jsonb(NEW) - 'before' - 'after') = (to_jsonb(OLD) - 'before' - 'after') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
DROP FUNCTION audit_jsonb_only_removed(jsonb, jsonb);
DROP INDEX sign_in_step_account_idx;
DROP INDEX message_button_press_from_phone_idx;
DROP INDEX audit_log_after_account_idx;
DROP INDEX audit_log_before_account_idx;

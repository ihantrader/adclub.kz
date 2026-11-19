-- Up Migration
-- Deleting the account, consents with versions, the export of a user's data
-- (TASK-072, D-077; ARCHITECTURE 4.96, 8.5):
-- - an account the member deleted keeps its row (orders, reviews, the
--   journal point at it) with `status = 'deleted'`, `deleted_at`, the phone
--   replaced by a keyed hash written in letters (`deleted:…`) and no name,
--   e-mail, city or language; `erased_at` — the retention has passed and the
--   last traces (the hash, the consents) are gone too;
-- - a session ended because its account was deleted: `account_deleted`;
-- - the journal of consents: every consent given is a row — what, which
--   version, when, from which client and platform. The consents to share
--   the number recorded on the account so far become its first rows;
-- - a one-time link of «Выгрузить данные…»: used once, for minutes;
-- - `audit_log` stays append-only, with one exception: inside a transaction
--   that sets `adclub.audit_redaction` to `on`, `before` and `after` of an
--   entry may be rewritten — nothing else of it. Deleting the account uses
--   it to take the name and the e-mail out of the entries about the account.

ALTER TABLE account DROP CONSTRAINT account_status_check;
ALTER TABLE account ADD CONSTRAINT account_status_check
  CHECK (status IN ('active', 'blocked', 'deleted'));
ALTER TABLE account
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN erased_at TIMESTAMPTZ;
ALTER TABLE account ADD CONSTRAINT account_deleted_check CHECK (
  (status = 'deleted') = (deleted_at IS NOT NULL)
  AND (erased_at IS NULL OR deleted_at IS NOT NULL)
  AND (status <> 'deleted' OR (name IS NULL AND email IS NULL AND phone LIKE 'deleted:%'))
);
CREATE INDEX account_deleted_idx ON account (deleted_at)
  WHERE deleted_at IS NOT NULL AND erased_at IS NULL;

ALTER TABLE session DROP CONSTRAINT session_revoked_reason_check;
ALTER TABLE session ADD CONSTRAINT session_revoked_reason_check CHECK (revoked_reason IN (
  'logout', 'ended_by_owner', 'ended_others', 'ended_all', 'refresh_reuse', 'access_closed',
  'admin_removed', 'totp_reset', 'ended_by_admin', 'account_deleted'
));

CREATE TABLE account_consent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL CHECK (kind IN ('phone_share', 'terms', 'vehicle_document')),
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 50),
  given_at TIMESTAMPTZ NOT NULL,
  -- Where it was given: the kind of the session, or `migration` for the
  -- consents recorded before the journal existed.
  client TEXT NOT NULL CHECK (client IN ('mobile', 'supplier_web', 'admin_web', 'migration')),
  platform TEXT CHECK (platform IS NULL OR length(platform) <= 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_consent_account_idx ON account_consent (account_id, given_at DESC);

INSERT INTO account_consent (account_id, kind, version, given_at, client)
  SELECT id, 'phone_share', left(consent_version, 50), consent_phone_share_at, 'migration'
  FROM account
  WHERE consent_phone_share_at IS NOT NULL AND consent_version IS NOT NULL;

CREATE TABLE account_data_export (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account (id),
  admin_user_id UUID NOT NULL REFERENCES admin_user (id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX account_data_export_account_idx ON account_data_export (account_id, created_at DESC);

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

-- Down Migration
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;
DROP TABLE account_data_export;
DROP TABLE account_consent;
ALTER TABLE session DROP CONSTRAINT session_revoked_reason_check;
ALTER TABLE session ADD CONSTRAINT session_revoked_reason_check CHECK (revoked_reason IN (
  'logout', 'ended_by_owner', 'ended_others', 'ended_all', 'refresh_reuse', 'access_closed',
  'admin_removed', 'totp_reset', 'ended_by_admin'
));
DROP INDEX account_deleted_idx;
ALTER TABLE account DROP CONSTRAINT account_deleted_check;
ALTER TABLE account DROP COLUMN erased_at, DROP COLUMN deleted_at;
ALTER TABLE account DROP CONSTRAINT account_status_check;
ALTER TABLE account ADD CONSTRAINT account_status_check CHECK (status IN ('active', 'blocked'));

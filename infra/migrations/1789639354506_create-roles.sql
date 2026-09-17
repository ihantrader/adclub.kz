-- Up Migration
-- Roles and contexts (ARCHITECTURE.md 5.1, 8.1, 8.3; TASK-006): companies
-- and their employees, administrators with a TOTP second factor, and
-- unfinished sign-ins (choosing a company, the admin second factor).

-- A company. Only what signing in to the cabinet needs; the supplier
-- lifecycle (lead, requisites, locations, pause and blocking as features)
-- adds columns in TASK-016. Pause and blocking never close the cabinet.
CREATE TABLE supplier (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- Free text until the city directory exists (city_id, ARCHITECTURE 5.5).
  city TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_name_check CHECK (btrim(name) <> ''),
  CONSTRAINT supplier_status_check CHECK (status IN ('draft', 'active', 'paused', 'blocked'))
);

-- An employee of a company (PRODUCT 12.6). Removing one keeps the row
-- (order history refers to it); all employees are equal in the MVP, role
-- and permissions are reserved for BACKLOG.
CREATE TABLE supplier_member (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  account_id UUID NOT NULL REFERENCES account (id),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  role TEXT NOT NULL DEFAULT 'member',
  permissions JSONB,
  -- Who added the employee: an administrator, a colleague or the operator command.
  added_by TEXT NOT NULL,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_member_display_name_check CHECK (btrim(display_name) <> ''),
  CONSTRAINT supplier_member_status_check CHECK (status IN ('active', 'removed')),
  CONSTRAINT supplier_member_removed_check CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CONSTRAINT supplier_member_role_check CHECK (role IN ('member')),
  CONSTRAINT supplier_member_added_by_check CHECK (added_by IN ('admin', 'member', 'operator')),
  -- One membership per person and company.
  CONSTRAINT supplier_member_account_supplier_key UNIQUE (account_id, supplier_id),
  -- Target of the session context key: the employee belongs to that company.
  CONSTRAINT supplier_member_id_supplier_key UNIQUE (id, supplier_id)
);

-- Active employees of a company (notifications, the employee list).
CREATE INDEX supplier_member_supplier_active_idx ON supplier_member (supplier_id)
  WHERE status = 'active';

-- An administrator (D-045: appointed and removed only by the operator
-- command; all equal in the MVP). The TOTP secret is encrypted with the
-- key from the environment; the last accepted time step stops a code
-- from being used twice.
CREATE TABLE admin_user (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account (id),
  role TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active',
  totp_secret TEXT,
  totp_confirmed_at TIMESTAMPTZ,
  totp_last_used_step BIGINT,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_user_role_check CHECK (role IN ('admin')),
  CONSTRAINT admin_user_status_check CHECK (status IN ('active', 'removed')),
  CONSTRAINT admin_user_removed_check CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CONSTRAINT admin_user_totp_check CHECK ((totp_secret IS NULL) = (totp_confirmed_at IS NULL))
);

CREATE UNIQUE INDEX admin_user_account_key ON admin_user (account_id);

-- One-time backup codes, stored as a keyed hash only. A new set revokes
-- the previous one; used and revoked codes stay for the record.
CREATE TABLE admin_backup_code (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES admin_user (id),
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX admin_backup_code_current_key ON admin_backup_code (admin_user_id, code_hash)
  WHERE revoked_at IS NULL;

-- An unfinished sign-in: the login code was spent, the next step (choose
-- a company, set up or enter the second factor) is still due. Only a
-- keyed hash of the step token is stored; the step works once and
-- briefly. Cleanup of old rows: background job (TASK-008).
CREATE TABLE sign_in_step (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES account (id),
  admin_user_id UUID REFERENCES admin_user (id),
  token_hash TEXT NOT NULL,
  -- Setup only: the secret offered to the authenticator app (encrypted).
  totp_secret TEXT,
  login_challenge_id UUID,
  client_platform TEXT,
  client_version TEXT,
  device_name TEXT,
  ip TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sign_in_step_kind_check CHECK (
    kind IN ('supplier_selection', 'admin_totp_setup', 'admin_totp')
  ),
  CONSTRAINT sign_in_step_admin_check CHECK (
    (kind = 'supplier_selection') = (admin_user_id IS NULL)
  ),
  CONSTRAINT sign_in_step_totp_secret_check CHECK (
    kind = 'admin_totp_setup' OR totp_secret IS NULL
  )
);

CREATE INDEX sign_in_step_expires_at_idx ON sign_in_step (expires_at);

-- Session context: the employee must belong to the session's company, and
-- a cabinet session always has one.
ALTER TABLE session
  ADD CONSTRAINT session_supplier_member_fkey
    FOREIGN KEY (supplier_member_id, supplier_id) REFERENCES supplier_member (id, supplier_id),
  ADD CONSTRAINT session_supplier_context_required_check CHECK (
    kind <> 'supplier_web' OR (supplier_id IS NOT NULL AND supplier_member_id IS NOT NULL)
  );

-- Sessions of one membership (removing an employee ends them, TASK-017).
CREATE INDEX session_supplier_member_active_idx ON session (supplier_member_id)
  WHERE revoked_at IS NULL AND supplier_member_id IS NOT NULL;

-- Sessions ended because the context was lost.
ALTER TABLE session DROP CONSTRAINT session_revoked_reason_check;
ALTER TABLE session ADD CONSTRAINT session_revoked_reason_check CHECK (
  revoked_reason IN (
    'logout', 'ended_by_owner', 'ended_others', 'ended_all', 'refresh_reuse',
    'access_closed', 'admin_removed', 'totp_reset'
  )
);

-- Down Migration
-- The previous reason list comes back NOT VALID: sessions already ended
-- for a new reason keep their row as it is.
ALTER TABLE session DROP CONSTRAINT session_revoked_reason_check;
ALTER TABLE session ADD CONSTRAINT session_revoked_reason_check CHECK (
  revoked_reason IN ('logout', 'ended_by_owner', 'ended_others', 'ended_all', 'refresh_reuse')
) NOT VALID;
DROP INDEX session_supplier_member_active_idx;
ALTER TABLE session
  DROP CONSTRAINT session_supplier_context_required_check,
  DROP CONSTRAINT session_supplier_member_fkey;
DROP TABLE sign_in_step;
DROP TABLE admin_backup_code;
DROP TABLE admin_user;
DROP TABLE supplier_member;
DROP TABLE supplier;

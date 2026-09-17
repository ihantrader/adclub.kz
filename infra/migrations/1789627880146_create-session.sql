-- Up Migration
-- Revocable sign-in sessions (ARCHITECTURE.md 5.1, 8.2; TASK-005).
--
-- Tokens are never stored. The refresh token of generation N is an HMAC
-- (server secret) over the session id, N and refresh_seed, so the database
-- alone can't produce a usable token, while the server can recognize any
-- earlier generation of the session (refresh token reuse ends the session).
-- The access token is checked against this row on every request: a
-- revoked or expired session stops working at once.
CREATE TABLE session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account (id),
  kind TEXT NOT NULL,
  -- Supplier cabinet context (company and employee), filled in TASK-006.
  supplier_id UUID,
  supplier_member_id UUID,
  refresh_seed TEXT NOT NULL,
  refresh_generation INTEGER NOT NULL DEFAULT 0,
  refresh_rotated_at TIMESTAMPTZ,
  -- The otp_challenge that proved the phone number at sign-in.
  login_challenge_id UUID,
  -- From X-Client and the sign-in request; shown in the list of sessions.
  client_platform TEXT,
  client_version TEXT,
  device_name TEXT,
  last_ip TEXT,
  last_used_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  -- Hard end no refresh can move (the admin session: sign-in + 12 h).
  absolute_expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT session_kind_check CHECK (kind IN ('mobile', 'supplier_web', 'admin_web')),
  CONSTRAINT session_context_check CHECK (
    kind = 'supplier_web' OR (supplier_id IS NULL AND supplier_member_id IS NULL)
  ),
  CONSTRAINT session_refresh_generation_check CHECK (refresh_generation >= 0),
  CONSTRAINT session_expiry_check CHECK (
    absolute_expires_at IS NULL OR expires_at <= absolute_expires_at
  ),
  CONSTRAINT session_revoked_check CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT session_revoked_reason_check CHECK (
    revoked_reason IN ('logout', 'ended_by_owner', 'ended_others', 'ended_all', 'refresh_reuse')
  )
);

-- The owner's list of devices and "end all sessions".
CREATE INDEX session_account_active_idx ON session (account_id) WHERE revoked_at IS NULL;

-- Cleanup of expired sessions (background job, TASK-008).
CREATE INDEX session_expires_at_idx ON session (expires_at);

-- Down Migration
DROP TABLE session;

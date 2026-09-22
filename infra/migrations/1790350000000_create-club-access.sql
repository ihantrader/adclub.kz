-- Up Migration
-- Club access of users given by hand (ARCHITECTURE.md 4.29; TASK-020;
-- D-059; PRODUCT 9, 14.2).
--
-- Until the subscriptions of the stores arrive (EPIC-14, TASK-040) the
-- only source of club access is a grant by an administrator or the server
-- operator command — for the internal alpha, test users and the club's
-- staff: until a moment, with a reason. One server function reads it
-- (`ClubAccess`); TASK-040 adds subscriptions to that function.
--
-- A grant is never deleted: revoked early, expired or replaced by a newer
-- one, it stays as history (the journal of actions has every change too).

CREATE TABLE club_access_grant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account (id),
  source TEXT NOT NULL DEFAULT 'manual',
  valid_until TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  -- Who gave it: an administrator (with their id) or the operator command.
  granted_by_role TEXT NOT NULL,
  granted_by_admin_id UUID REFERENCES admin_user (id),
  -- Ended before `valid_until`: revoked by hand, or replaced by a newer
  -- grant of the account.
  ended_at TIMESTAMPTZ,
  ended_how TEXT,
  ended_by_role TEXT,
  ended_by_admin_id UUID REFERENCES admin_user (id),
  end_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT club_access_grant_source_check CHECK (source IN ('manual')),
  CONSTRAINT club_access_grant_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT club_access_grant_granted_by_check CHECK (
    (granted_by_role = 'admin' AND granted_by_admin_id IS NOT NULL)
    OR (granted_by_role = 'operator' AND granted_by_admin_id IS NULL)
  ),
  CONSTRAINT club_access_grant_ended_check CHECK (
    (ended_at IS NULL AND ended_how IS NULL AND ended_by_role IS NULL
      AND ended_by_admin_id IS NULL AND end_reason IS NULL)
    OR (ended_at IS NOT NULL AND ended_how IN ('revoked', 'replaced')
      AND ((ended_by_role = 'admin' AND ended_by_admin_id IS NOT NULL)
        OR (ended_by_role = 'operator' AND ended_by_admin_id IS NULL))
      AND end_reason IS NOT NULL AND length(btrim(end_reason)) BETWEEN 1 AND 500)
  )
);

-- At most one grant of an account that hasn't been ended by hand: a new
-- grant ends the current one in the same transaction.
CREATE UNIQUE INDEX club_access_grant_open_key ON club_access_grant (account_id)
  WHERE ended_at IS NULL;
CREATE INDEX club_access_grant_created_idx ON club_access_grant (created_at DESC, id DESC);

-- Down Migration
DROP TABLE club_access_grant;

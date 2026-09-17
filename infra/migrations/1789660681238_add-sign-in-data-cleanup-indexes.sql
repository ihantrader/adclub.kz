-- Up Migration
-- Cleanup of stale sign-in data (ARCHITECTURE 4.12, 14; TASK-008, D-054).
-- The cleanup looks rows up by the moment they stopped being usable:
--   otp_challenge — consumed, or else the end of its validity;
--   sign_in_step  — consumed, or else the end of its validity;
--   session       — ended, or else its expiry (an expired session is never
--                   extended again).
-- A row whose moment is in the future is in use and is never deleted.
CREATE INDEX otp_challenge_ended_at_idx
  ON otp_challenge ((COALESCE(consumed_at, expires_at)));

CREATE INDEX sign_in_step_ended_at_idx
  ON sign_in_step ((COALESCE(consumed_at, expires_at)));

CREATE INDEX session_ended_at_idx
  ON session ((COALESCE(revoked_at, expires_at)));

-- Down Migration
DROP INDEX session_ended_at_idx;
DROP INDEX sign_in_step_ended_at_idx;
DROP INDEX otp_challenge_ended_at_idx;

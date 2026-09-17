-- Up Migration
-- One-time login codes (ARCHITECTURE.md 5.1, 8.1; TASK-004). The code
-- itself is never stored, only its HMAC. Lifecycle (status):
--   pending    -> created, delivery in progress
--   active     -> delivered, the only code a phone accepts
--   consumed   -> entered correctly (single use)
--   superseded -> replaced by a newer delivered code
--   expired    -> entered after expires_at
--   exhausted  -> too many wrong entries
--   failed     -> no channel delivered it
CREATE TABLE otp_challenge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  status TEXT NOT NULL DEFAULT 'pending',
  channel TEXT,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT otp_challenge_purpose_check CHECK (purpose IN ('login', 'phone_change')),
  CONSTRAINT otp_challenge_status_check CHECK (
    status IN ('pending', 'active', 'consumed', 'superseded', 'expired', 'exhausted', 'failed')
  ),
  CONSTRAINT otp_challenge_channel_check CHECK (channel IN ('whatsapp', 'sms')),
  CONSTRAINT otp_challenge_active_has_channel_check CHECK (
    status NOT IN ('active', 'consumed') OR channel IS NOT NULL
  ),
  CONSTRAINT otp_challenge_attempts_check CHECK (attempts >= 0 AND max_attempts > 0)
);

-- At most one code a phone accepts at any moment, whatever the races.
CREATE UNIQUE INDEX otp_challenge_one_active_key
  ON otp_challenge (phone, purpose)
  WHERE status = 'active';

-- Cleanup of old challenges by age (background job, TASK-008).
CREATE INDEX otp_challenge_created_at_idx ON otp_challenge (created_at);

-- Channel of the last code a phone number was confirmed with — "no
-- WhatsApp" in the profile (PRODUCT 15) is derived from it. Kept per
-- phone: an account may not exist yet when a number is confirmed.
CREATE TABLE phone_verification (
  phone TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phone_verification_channel_check CHECK (channel IN ('whatsapp', 'sms'))
);

-- Down Migration
DROP TABLE phone_verification;
DROP TABLE otp_challenge;

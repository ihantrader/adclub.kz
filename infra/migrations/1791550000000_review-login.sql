-- Up Migration
-- The sign-in for store review (TASK-077; PRODUCT 5; ARCHITECTURE 4.73).
--
-- App Store and Google Play reviewers sign in to the release build with a
-- number and a code given to them in advance: no WhatsApp or SMS reaches
-- them. `review_login` holds that number and the HMAC of its code — the code
-- itself is never stored — with a term that has to be given. Only the
-- operator command sets it (`review-login:enable|disable|status`): it is
-- sign-in security (D-053), the API never changes it. Rows are never
-- deleted: a disabled or replaced one stays as history. At most one is
-- enabled at a time — a partial unique index.
--
-- `otp_challenge.review_login_id` — a challenge opened for the review number
-- by the mobile app: nothing is sent, and its code is checked against
-- `review_login.code_hash` instead of its own `code_hash` (which is unused
-- and empty), only while that row is enabled and in term.

CREATE TABLE review_login (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT review_login_phone_format CHECK (phone ~ '^\+77[0-9]{9}$'),
  CONSTRAINT review_login_reason_present CHECK (length(btrim(reason)) > 0),
  CONSTRAINT review_login_disabled_reason CHECK ((disabled_at IS NULL) = (disabled_reason IS NULL))
);

CREATE UNIQUE INDEX review_login_one_enabled ON review_login ((true)) WHERE disabled_at IS NULL;

ALTER TABLE otp_challenge ADD COLUMN review_login_id UUID REFERENCES review_login (id);

CREATE INDEX otp_challenge_review_login_idx ON otp_challenge (review_login_id)
  WHERE review_login_id IS NOT NULL;

-- Down Migration
DROP INDEX otp_challenge_review_login_idx;
ALTER TABLE otp_challenge DROP COLUMN review_login_id;
DROP TABLE review_login;

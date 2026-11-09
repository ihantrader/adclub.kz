-- Up Migration
-- Testers' numbers on staging (TASK-055; ARCHITECTURE 4.82): staging has no
-- real channels (nobody sees a test channel's codes, and /dev/login-codes is
-- closed there), so the people who try it — testers, the Product Owner, the
-- administrators — sign in with numbers whose constant codes the operator
-- sets, as the store reviewers do (TASK-077).
--
-- `scope`:
--   store_review  as before: the app only, one enabled at a time, any environment
--   tester        the app, the cabinet and the admin panel (an administrator
--                 still needs the second factor); outside production only;
--                 up to 10 enabled, a term of at most 31 days (checked by
--                 the operator command, ReviewLogins)
-- A number has at most one enabled row of either scope.

ALTER TABLE review_login ADD COLUMN scope TEXT NOT NULL DEFAULT 'store_review'
  CHECK (scope IN ('store_review', 'tester'));

DROP INDEX review_login_one_enabled;
CREATE UNIQUE INDEX review_login_one_store_review ON review_login ((true))
  WHERE disabled_at IS NULL AND scope = 'store_review';
CREATE UNIQUE INDEX review_login_one_per_phone ON review_login (phone)
  WHERE disabled_at IS NULL;

-- Down Migration
-- Testers' rows end (their codes stop working); the store review one stays.
UPDATE otp_challenge SET status = 'expired', updated_at = now()
  WHERE status IN ('pending', 'active')
    AND review_login_id IN (SELECT id FROM review_login WHERE scope = 'tester');
UPDATE review_login SET disabled_at = now(), disabled_reason = 'migration rolled back', updated_at = now()
  WHERE scope = 'tester' AND disabled_at IS NULL;
DROP INDEX review_login_one_per_phone;
DROP INDEX review_login_one_store_review;
CREATE UNIQUE INDEX review_login_one_enabled ON review_login ((true)) WHERE disabled_at IS NULL;
ALTER TABLE review_login DROP COLUMN scope;

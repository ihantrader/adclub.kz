-- Up Migration
-- Billing in the admin panel (TASK-043; ARCHITECTURE 4.78).
--
-- 1. **A planned tariff can be cancelled, never deleted** (I851). The record stays as
--    history with who cancelled it and why; every reader of the tariffs (the one in
--    effect, the announced one) leaves cancelled records out. One start per audience is
--    now unique among the records that are not cancelled, so a date freed by a
--    cancellation can be planned again.
-- 2. **Indexes of the summary and its lists** (I848): the first start and the end of
--    a user's subscription are read from its applied events; the charges are read by
--    their moment; the attempts waiting for the provider are found per company.

ALTER TABLE plan
  ADD COLUMN cancelled_at TIMESTAMPTZ,
  ADD COLUMN cancelled_by_role TEXT,
  ADD COLUMN cancel_reason TEXT,
  ADD CONSTRAINT plan_cancelled_check CHECK (
    (cancelled_at IS NULL AND cancelled_by_role IS NULL AND cancel_reason IS NULL)
    OR (
      cancelled_at IS NOT NULL
      AND cancelled_by_role IS NOT NULL
      AND cancelled_by_role IN ('operator', 'admin')
      AND cancel_reason IS NOT NULL
      AND length(btrim(cancel_reason)) > 0
    )
  );

ALTER TABLE plan DROP CONSTRAINT plan_audience_from_key;
CREATE UNIQUE INDEX plan_audience_from_key ON plan (audience, valid_from)
  WHERE cancelled_at IS NULL;

CREATE INDEX billing_event_subscription_moves_idx
  ON billing_event (subscription_id, kind, event_at)
  WHERE outcome = 'applied';
CREATE INDEX billing_event_subscription_ends_idx
  ON billing_event (subscription_id, event_at)
  WHERE outcome = 'applied' AND to_status = 'expired';
CREATE INDEX subscription_audience_status_idx ON subscription (audience, status);
CREATE INDEX payment_attempt_created_idx ON payment_attempt (created_at DESC, id DESC);
CREATE INDEX payment_attempt_waiting_idx ON payment_attempt (supplier_id)
  WHERE status IN ('unavailable', 'unknown');

-- Down Migration
DROP INDEX payment_attempt_waiting_idx;
DROP INDEX payment_attempt_created_idx;
DROP INDEX subscription_audience_status_idx;
DROP INDEX billing_event_subscription_ends_idx;
DROP INDEX billing_event_subscription_moves_idx;

DELETE FROM plan WHERE cancelled_at IS NOT NULL;
DROP INDEX plan_audience_from_key;
ALTER TABLE plan ADD CONSTRAINT plan_audience_from_key UNIQUE (audience, valid_from);

ALTER TABLE plan
  DROP CONSTRAINT plan_cancelled_check,
  DROP COLUMN cancel_reason,
  DROP COLUMN cancelled_by_role,
  DROP COLUMN cancelled_at;

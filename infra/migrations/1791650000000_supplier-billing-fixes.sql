-- Up Migration
-- What the acceptance of TASK-042 found (TASK-042.A; ARCHITECTURE 4.77 I839, I841).
--
-- 1. **One first charge per company until its subscription begins** (I839). The
--    subscription of a card is born when the event of its first charge is applied, a
--    moment after the charge itself; a second «Привязать карту» in that moment would
--    charge the first term again. A first charge that is not over or that succeeded and
--    is not yet tied to its subscription is now one per company — a unique index, so no
--    race and no second worker can make another. The subscription, once born, is written
--    into its first charge (`subscription_id`), which takes the charge out of the index:
--    a company whose subscription ended can begin a new one.
--
-- 2. **The «billing» pauses put by hand before billing existed** (I841). Before TASK-042
--    an administrator could pause a company «for billing»; `1791600000000` moved such
--    pauses to `billing_paused_at`, which only a subscription lifts — and these companies
--    have none, so nobody could lift them. The pause of a company without a subscription
--    is handed to the administrator, who put it; the note marks it, and down gives it back.

UPDATE payment_attempt a
SET subscription_id = (
  SELECT s.id FROM subscription s
  WHERE s.supplier_id = a.supplier_id
  ORDER BY (s.provider_ref = a.period_key) DESC, s.created_at DESC
  LIMIT 1
)
WHERE a.kind = 'first'
  AND a.subscription_id IS NULL
  AND a.status = 'succeeded'
  AND EXISTS (SELECT 1 FROM subscription s WHERE s.supplier_id = a.supplier_id);

CREATE UNIQUE INDEX payment_attempt_first_unbound_key ON payment_attempt (supplier_id)
  WHERE kind = 'first' AND subscription_id IS NULL
    AND status IN ('created', 'unavailable', 'unknown', 'succeeded');

UPDATE supplier SET
  admin_paused_at = coalesce(admin_paused_at, billing_paused_at),
  admin_pause_note = CASE
    WHEN admin_paused_at IS NULL THEN 'Пауза «оплата», поставленная до подписок (TASK-042.A)'
    ELSE admin_pause_note
  END,
  billing_paused_at = NULL
WHERE billing_paused_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.supplier_id = supplier.id);

-- Down Migration
UPDATE supplier SET
  billing_paused_at = admin_paused_at,
  admin_paused_at = NULL,
  admin_pause_note = NULL
WHERE admin_pause_note = 'Пауза «оплата», поставленная до подписок (TASK-042.A)'
  AND billing_paused_at IS NULL;

DROP INDEX payment_attempt_first_unbound_key;

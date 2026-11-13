-- Up Migration
-- Reminders about a planned replacement (TASK-069; PRODUCT 6.5; SCREENS
-- M-REM-01, M-REM-02, M-PRO-04; D-038; ARCHITECTURE 5.8, 4.87).

-- M-PRO-04 «Напоминания о замене»: off — neither the cards nor the pushes.
ALTER TABLE account ADD COLUMN reminders_enabled BOOLEAN NOT NULL DEFAULT true;

-- The mileage question of a car (M-REM-02, P-REM-02): «Не сейчас» puts it
-- off until the next day; the last P-REM-02 keeps the next one away for
-- `mileage_ask_days`.
ALTER TABLE account_car ADD COLUMN mileage_question_dismissed_until TIMESTAMPTZ;
ALTER TABLE account_car ADD COLUMN mileage_pushed_at TIMESTAMPTZ;
-- The same mileage as the last reading, confirmed: no reading is written for it
-- (TASK-058), but the question is answered.
ALTER TABLE account_car ADD COLUMN mileage_confirmed_at TIMESTAMPTZ;

-- One row per car and element of its plan, made when there is something to
-- keep: «Уже поменял» (the replacement the person marked), «Напомнить
-- позже», the push sent for the current replacement, and what the daily
-- job last counted from (the order, the mark or the schedule) — the last
-- for the admin panel's view only; the count itself is always made anew.
CREATE TABLE maintenance_reminder (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  car_id UUID NOT NULL REFERENCES account_car (id) ON DELETE CASCADE,
  plan_item_id UUID NOT NULL REFERENCES maintenance_plan_item (id) ON DELETE CASCADE,
  -- «Уже поменял»: the mileage and the moment the person marked.
  done_km INTEGER CHECK (done_km IS NULL OR done_km BETWEEN 0 AND 2000000),
  done_at TIMESTAMPTZ,
  -- What the count was last made from.
  last_source TEXT CHECK (last_source IN ('order', 'user', 'schedule')),
  last_km INTEGER,
  last_at TIMESTAMPTZ,
  last_order_id UUID REFERENCES customer_order (id) ON DELETE SET NULL,
  due_km INTEGER,
  due_at TIMESTAMPTZ,
  snoozed_until TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  -- The replacement the last push was about: one push per replacement.
  notified_cycle TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A mark without a mileage is counted by its date (no reading was known).
  CONSTRAINT maintenance_reminder_done CHECK (done_km IS NULL OR done_at IS NOT NULL),
  CONSTRAINT maintenance_reminder_car_item_key UNIQUE (car_id, plan_item_id)
);

CREATE INDEX maintenance_reminder_account_idx ON maintenance_reminder (account_id);
CREATE INDEX maintenance_reminder_plan_item_idx ON maintenance_reminder (plan_item_id);

-- P-REM-02 «Обновите пробег»: a kind of its own (`notificationKinds` of the contract).
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (
  event_kind IN (
    'order_accepted', 'order_ready', 'order_confirmed', 'order_declined',
    'order_expired_no_response', 'term_proposed', 'time_proposed', 'reserve_expiring',
    'order_closed', 'supply_overdue', 'review_text_rejected', 'maintenance_reminder',
    'mileage_request', 'payment_failed'
  )
);

-- Down Migration
DELETE FROM notification WHERE event_kind = 'mileage_request';
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (
  event_kind IN (
    'order_accepted', 'order_ready', 'order_confirmed', 'order_declined',
    'order_expired_no_response', 'term_proposed', 'time_proposed', 'reserve_expiring',
    'order_closed', 'supply_overdue', 'review_text_rejected', 'maintenance_reminder',
    'payment_failed'
  )
);
DROP TABLE maintenance_reminder;
ALTER TABLE account_car DROP COLUMN mileage_confirmed_at;
ALTER TABLE account_car DROP COLUMN mileage_pushed_at;
ALTER TABLE account_car DROP COLUMN mileage_question_dismissed_until;
ALTER TABLE account DROP COLUMN reminders_enabled;

-- Up Migration
-- Orders on services (TASK-038; PRODUCT 11; ARCHITECTURE 6.3, 4.62). The
-- same `customer_order`, of the kind `service`: one visit (quantity 1, at the
-- point — `fulfillment = 'pickup'`), for one car of the user's garage, at a
-- time:
--
-- - `car_id` — the car of the garage the visit is for (the link goes when
--   the car is removed from the garage — the order lives by its snapshot);
--   `car_snapshot` — make, model and year as they were (the price depends
--   on the model);
-- - `desired_at` — the time the user asked for;
-- - `proposed_at` — another time an employee proposed; the proposal itself
--   is `term_proposed_at` and the user's answer is due by `term_answer_by`,
--   the same columns and the same status `term_proposed` as another term of
--   an order under order (one «нужен ваш ответ»);
-- - `visit_at` — the time of the visit once confirmed, `visit_until` — the
--   end of its window (`service_grace_hours` after it).
--
-- Two final statuses: `no_show` (an employee marked that the user did not
-- come) and `visit_unresolved` (nobody closed or marked the visit in its
-- window; a late close is still possible, as for an expired reserve).
-- «Подтверждена на время» is `accepted` of a service.

ALTER TABLE customer_order DROP CONSTRAINT customer_order_kind_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_kind_check
  CHECK (kind IN ('stock', 'on_order', 'service'));

ALTER TABLE customer_order DROP CONSTRAINT customer_order_status_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_status_check CHECK (status IN (
  'created', 'accepted', 'ready', 'completed',
  'cancelled_by_user', 'declined_by_supplier', 'response_expired', 'reserve_expired',
  'cancelled_by_admin', 'term_proposed', 'term_expired', 'no_show', 'visit_unresolved'
));

ALTER TABLE customer_order
  ADD COLUMN car_id UUID REFERENCES account_car (id) ON DELETE SET NULL,
  ADD COLUMN car_snapshot JSONB,
  ADD COLUMN desired_at TIMESTAMPTZ,
  ADD COLUMN proposed_at TIMESTAMPTZ,
  ADD COLUMN visit_at TIMESTAMPTZ,
  ADD COLUMN visit_until TIMESTAMPTZ,
  ADD CONSTRAINT customer_order_service_check CHECK (
    -- A service has its car and the time asked for; nothing else has them.
    (kind = 'service') = (car_snapshot IS NOT NULL)
    AND (kind = 'service') = (desired_at IS NOT NULL)
    AND (kind = 'service' OR (car_id IS NULL AND proposed_at IS NULL AND visit_at IS NULL))
    AND (car_snapshot IS NULL OR (
      jsonb_typeof(car_snapshot -> 'make') = 'object' AND jsonb_typeof(car_snapshot -> 'model') = 'object'
    ))
    -- One visit at the point: no quantity, no delivery, no reserve, no «ready».
    AND (kind <> 'service' OR (
      quantity = 1 AND fulfillment = 'pickup' AND expires_at IS NULL AND ready_at IS NULL
    ))
    -- A proposal of another time is whole.
    AND (kind <> 'service' OR (proposed_at IS NULL) = (term_proposed_at IS NULL))
    -- A confirmed visit has its window; only a taken-on service has one.
    AND (visit_at IS NULL) = (visit_until IS NULL)
    AND (visit_at IS NULL OR accepted_at IS NOT NULL)
    AND (kind <> 'service' OR status NOT IN ('accepted', 'no_show', 'visit_unresolved')
      OR visit_at IS NOT NULL)
    AND (status NOT IN ('no_show', 'visit_unresolved') OR kind = 'service')
  );

-- The term of TASK-037 knew one proposal — of working days. Another time of
-- a service is a proposal too (`term_proposed_at`, `term_answer_by`), told
-- by `proposed_at` instead of `proposed_lead_days`.
ALTER TABLE customer_order DROP CONSTRAINT customer_order_term_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_term_check CHECK (
  (kind = 'on_order' OR (
    expected_ready_on IS NULL AND proposed_lead_days IS NULL AND confirmed_lead_days IS NULL
    AND supply_overdue_at IS NULL
  ))
  AND (proposed_lead_days IS NULL) = (proposed_ready_on IS NULL)
  AND (kind <> 'on_order' OR (proposed_lead_days IS NULL) = (term_proposed_at IS NULL))
  AND (kind <> 'stock' OR term_proposed_at IS NULL)
  AND (term_proposed_at IS NULL) = (term_answer_by IS NULL)
  AND (proposed_lead_days IS NULL OR proposed_lead_days >= 1)
  AND (confirmed_lead_days IS NULL OR confirmed_lead_days >= 0)
  AND (status <> 'term_proposed' OR (kind IN ('on_order', 'service') AND term_proposed_at IS NOT NULL))
  AND (status <> 'term_expired' OR term_proposed_at IS NOT NULL)
  AND (kind <> 'on_order' OR confirmed_lead_days IS NULL OR accepted_at IS NOT NULL)
  AND (supply_overdue_at IS NULL OR confirmed_lead_days IS NOT NULL)
  AND (supply_overdue_noted_at IS NULL OR supply_overdue_at IS NOT NULL)
);

-- A no-show and an unresolved visit were taken on; the unresolved one keeps
-- its late close window, as an expired reserve.
ALTER TABLE customer_order DROP CONSTRAINT customer_order_accepted_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_accepted_check CHECK (
  (accepted_at IS NULL) = (phone_revealed_at IS NULL)
  AND (status NOT IN ('created', 'term_proposed', 'term_expired') OR accepted_at IS NULL)
  AND (status NOT IN ('accepted', 'ready', 'reserve_expired', 'no_show', 'visit_unresolved')
    OR accepted_at IS NOT NULL)
  AND (status <> 'completed' OR accepted_at IS NOT NULL OR close_method = 'admin')
);
ALTER TABLE customer_order DROP CONSTRAINT customer_order_late_close_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_late_close_check
  CHECK (status NOT IN ('reserve_expired', 'visit_unresolved') OR late_close_until IS NOT NULL);

-- The sweeper: a confirmed visit whose window is over, and the code of an
-- unresolved visit whose late close window has passed.
CREATE INDEX customer_order_visit_until_idx ON customer_order (visit_until)
  WHERE status = 'accepted' AND visit_until IS NOT NULL;
DROP INDEX customer_order_late_close_idx;
CREATE INDEX customer_order_late_close_idx ON customer_order (late_close_until)
  WHERE status IN ('reserve_expired', 'visit_unresolved') AND code_released_at IS NULL;

ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'close_late', 'admin_close',
  'cancel', 'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored',
  'deadline_extended', 'admin_cancel',
  'propose_term', 'agree_term', 'reject_term', 'expire_term', 'supply_overdue',
  'propose_time', 'mark_no_show', 'expire_visit', 'late_cancel'
));
-- `late_cancel` is a note: the user cancelled a confirmed visit less than
-- `late_cancel_hours` before it (ARCHITECTURE 6.3); the cancel itself is
-- the move before it.
ALTER TABLE order_event DROP CONSTRAINT order_event_move_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_move_check CHECK (
  CASE WHEN action IN ('reserve_expiring', 'late_action_ignored', 'deadline_extended',
      'supply_overdue', 'late_cancel')
    THEN to_status IS NULL
    ELSE to_status IS NOT NULL AND (action = 'create') = (from_status IS NULL)
  END
);

-- A no-show of a visit is the same mark of the user's discipline as a
-- pickup nobody came for (PRODUCT 10.5).
ALTER TABLE user_discipline_event DROP CONSTRAINT user_discipline_event_kind_check;
ALTER TABLE user_discipline_event ADD CONSTRAINT user_discipline_event_kind_check
  CHECK (kind IN ('pickup_no_show', 'service_no_show'));

-- Down Migration
-- The old rules know no service: its orders can't be told in their words
-- (a snapshot of a service is no item an order of goods takes), and the
-- rollback of TASK-019 that follows removes the offers on services they
-- point at. So the orders on services go, with their journal and their
-- discipline marks — the one thing this rollback removes; everything else
-- is as it was. The journal is append-only, so its trigger steps aside.
DELETE FROM user_discipline_event
WHERE order_id IN (SELECT id FROM customer_order WHERE kind = 'service');
ALTER TABLE order_event DISABLE TRIGGER order_event_immutable;
DELETE FROM order_event
WHERE order_id IN (SELECT id FROM customer_order WHERE kind = 'service');
ALTER TABLE order_event ENABLE TRIGGER order_event_immutable;
DELETE FROM customer_order WHERE kind = 'service';

ALTER TABLE user_discipline_event DROP CONSTRAINT user_discipline_event_kind_check;
ALTER TABLE user_discipline_event ADD CONSTRAINT user_discipline_event_kind_check
  CHECK (kind IN ('pickup_no_show'));

ALTER TABLE order_event DROP CONSTRAINT order_event_move_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_move_check CHECK (
  CASE WHEN action IN ('reserve_expiring', 'late_action_ignored', 'deadline_extended',
      'supply_overdue')
    THEN to_status IS NULL
    ELSE to_status IS NOT NULL AND (action = 'create') = (from_status IS NULL)
  END
);
ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'close_late', 'admin_close',
  'cancel', 'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored',
  'deadline_extended', 'admin_cancel',
  'propose_term', 'agree_term', 'reject_term', 'expire_term', 'supply_overdue'
));

DROP INDEX customer_order_late_close_idx;
CREATE INDEX customer_order_late_close_idx ON customer_order (late_close_until)
  WHERE status = 'reserve_expired' AND code_released_at IS NULL;
DROP INDEX customer_order_visit_until_idx;

ALTER TABLE customer_order DROP CONSTRAINT customer_order_late_close_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_late_close_check
  CHECK (status <> 'reserve_expired' OR late_close_until IS NOT NULL);
ALTER TABLE customer_order DROP CONSTRAINT customer_order_accepted_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_accepted_check CHECK (
  (accepted_at IS NULL) = (phone_revealed_at IS NULL)
  AND (status NOT IN ('created', 'term_proposed', 'term_expired') OR accepted_at IS NULL)
  AND (status NOT IN ('accepted', 'ready', 'reserve_expired') OR accepted_at IS NOT NULL)
  AND (status <> 'completed' OR accepted_at IS NOT NULL OR close_method = 'admin')
);
ALTER TABLE customer_order DROP CONSTRAINT customer_order_term_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_term_check CHECK (
  (kind = 'on_order' OR (
    expected_ready_on IS NULL AND proposed_lead_days IS NULL AND confirmed_lead_days IS NULL
    AND supply_overdue_at IS NULL
  ))
  AND (proposed_lead_days IS NULL) = (proposed_ready_on IS NULL)
  AND (proposed_lead_days IS NULL) = (term_proposed_at IS NULL)
  AND (proposed_lead_days IS NULL) = (term_answer_by IS NULL)
  AND (proposed_lead_days IS NULL OR proposed_lead_days >= 1)
  AND (confirmed_lead_days IS NULL OR confirmed_lead_days >= 0)
  AND (status <> 'term_proposed' OR (kind = 'on_order' AND proposed_lead_days IS NOT NULL))
  AND (status <> 'term_expired' OR proposed_lead_days IS NOT NULL)
  AND (kind <> 'on_order' OR confirmed_lead_days IS NULL OR accepted_at IS NOT NULL)
  AND (supply_overdue_at IS NULL OR confirmed_lead_days IS NOT NULL)
  AND (supply_overdue_noted_at IS NULL OR supply_overdue_at IS NOT NULL)
);

ALTER TABLE customer_order
  DROP CONSTRAINT customer_order_service_check,
  DROP COLUMN visit_until,
  DROP COLUMN visit_at,
  DROP COLUMN proposed_at,
  DROP COLUMN desired_at,
  DROP COLUMN car_snapshot,
  DROP COLUMN car_id;

ALTER TABLE customer_order DROP CONSTRAINT customer_order_status_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_status_check CHECK (status IN (
  'created', 'accepted', 'ready', 'completed',
  'cancelled_by_user', 'declined_by_supplier', 'response_expired', 'reserve_expired',
  'cancelled_by_admin', 'term_proposed', 'term_expired'
));
ALTER TABLE customer_order DROP CONSTRAINT customer_order_kind_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_kind_check
  CHECK (kind IN ('stock', 'on_order'));

-- Up Migration
-- Orders under order (TASK-037; PRODUCT 10.3, 10.4; ARCHITECTURE 6.2, 4.59).
-- The same `customer_order`, of the kind `on_order`, with its term:
--
-- - `expected_ready_on` — the date the offer's term (`lead_days` of the
--   snapshot) gave when the user ordered; the user agreed to that term;
-- - `proposed_lead_days`, `proposed_ready_on`, `term_proposed_at`,
--   `term_answer_by` — another term an employee proposed, the date it gives
--   by the point's working days, and until when the user answers;
-- - `confirmed_lead_days` — the term the order is held to, once confirmed by
--   the supplier or agreed to by the user (its date is `receipt_on`, its
--   moment `accepted_at`);
-- - `supply_overdue_at` — the moment the confirmed date has passed in the
--   point's time zone, and `supply_overdue_noted_at` — when the sweeper
--   noted that the order was not ready by then (once per order).
--
-- Two statuses: `term_proposed` (active — the user's answer is due) and
-- `term_expired` (final — the user did not answer). «Срок подтверждён» is
-- `accepted` of an order of this kind.

ALTER TABLE customer_order DROP CONSTRAINT customer_order_kind_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_kind_check
  CHECK (kind IN ('stock', 'on_order'));

ALTER TABLE customer_order DROP CONSTRAINT customer_order_status_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_status_check CHECK (status IN (
  'created', 'accepted', 'ready', 'completed',
  'cancelled_by_user', 'declined_by_supplier', 'response_expired', 'reserve_expired',
  'cancelled_by_admin', 'term_proposed', 'term_expired'
));

ALTER TABLE customer_order
  ADD COLUMN expected_ready_on DATE,
  ADD COLUMN proposed_lead_days INTEGER,
  ADD COLUMN proposed_ready_on DATE,
  ADD COLUMN term_proposed_at TIMESTAMPTZ,
  ADD COLUMN term_answer_by TIMESTAMPTZ,
  ADD COLUMN confirmed_lead_days INTEGER,
  ADD COLUMN supply_overdue_at TIMESTAMPTZ,
  ADD COLUMN supply_overdue_noted_at TIMESTAMPTZ,
  -- The term belongs to an order under order only; a proposal is whole.
  ADD CONSTRAINT customer_order_term_check CHECK (
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
    -- A confirmed term is a term the order was taken on with.
    AND (kind <> 'on_order' OR confirmed_lead_days IS NULL OR accepted_at IS NOT NULL)
    AND (supply_overdue_at IS NULL OR confirmed_lead_days IS NOT NULL)
    AND (supply_overdue_noted_at IS NULL OR supply_overdue_at IS NOT NULL)
  );

-- An order whose term waits for the user is still going on; one whose term
-- expired is over — and neither has opened the customer's phone.
ALTER TABLE customer_order DROP CONSTRAINT customer_order_finished_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_finished_check CHECK (
  (status IN ('created', 'accepted', 'ready', 'term_proposed')) = (finished_at IS NULL)
);
ALTER TABLE customer_order DROP CONSTRAINT customer_order_code_held_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_code_held_check CHECK (
  status NOT IN ('created', 'accepted', 'ready', 'term_proposed') OR code_released_at IS NULL
);
ALTER TABLE customer_order DROP CONSTRAINT customer_order_accepted_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_accepted_check CHECK (
  (accepted_at IS NULL) = (phone_revealed_at IS NULL)
  AND (status NOT IN ('created', 'term_proposed', 'term_expired') OR accepted_at IS NULL)
  AND (status NOT IN ('accepted', 'ready', 'reserve_expired') OR accepted_at IS NOT NULL)
  AND (status <> 'completed' OR accepted_at IS NOT NULL OR close_method = 'admin')
);

-- «Нет ли у пользователя активной заявки на это предложение»: the active
-- statuses grew by one.
DROP INDEX customer_order_user_offer_idx;
CREATE INDEX customer_order_user_offer_idx ON customer_order (user_account_id, offer_id)
  WHERE status IN ('created', 'accepted', 'ready', 'term_proposed');
-- The sweeper: the user's answer is due, and the supply is overdue.
CREATE INDEX customer_order_term_answer_by_idx ON customer_order (term_answer_by)
  WHERE status = 'term_proposed';
CREATE INDEX customer_order_supply_overdue_idx ON customer_order (supply_overdue_at)
  WHERE status = 'accepted' AND supply_overdue_noted_at IS NULL AND supply_overdue_at IS NOT NULL;

ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'close_late', 'admin_close',
  'cancel', 'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored',
  'deadline_extended', 'admin_cancel',
  'propose_term', 'agree_term', 'reject_term', 'expire_term', 'supply_overdue'
));
-- `supply_overdue` is a note: the status does not change (ARCHITECTURE 6.2).
ALTER TABLE order_event DROP CONSTRAINT order_event_move_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_move_check CHECK (
  CASE WHEN action IN ('reserve_expiring', 'late_action_ignored', 'deadline_extended',
      'supply_overdue')
    THEN to_status IS NULL
    ELSE to_status IS NOT NULL AND (action = 'create') = (from_status IS NULL)
  END
);

-- Down Migration
-- The old rules know orders in stock only. An order under order keeps
-- going as one in stock where it can (taken on — accepted, ready, given
-- out); one whose term waited for the user, or expired waiting, can't go on
-- under them and reads as cancelled by the user (the old rules have no
-- other final status that says «the user did not take it»). Its journal is
-- told in the old words: a proposal and an overdue supply become notes of
-- a moved deadline, the user's «yes» an accept, their «no» and silence a
-- cancel. The journal is append-only, so its trigger steps aside for this
-- one rewrite.
ALTER TABLE order_event DISABLE TRIGGER order_event_immutable;
UPDATE order_event SET action = 'deadline_extended', from_status = NULL, to_status = NULL
WHERE action IN ('propose_term', 'supply_overdue');
UPDATE order_event SET action = 'accept' WHERE action = 'agree_term';
UPDATE order_event SET action = 'cancel' WHERE action IN ('reject_term', 'expire_term');
UPDATE order_event SET from_status = 'created' WHERE from_status = 'term_proposed';
UPDATE order_event SET to_status = 'cancelled_by_user' WHERE to_status = 'term_expired';
UPDATE order_event SET to_status = 'created' WHERE to_status = 'term_proposed';
UPDATE order_event SET from_status = 'cancelled_by_user' WHERE from_status = 'term_expired';
ALTER TABLE order_event ENABLE TRIGGER order_event_immutable;

ALTER TABLE order_event DROP CONSTRAINT order_event_move_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_move_check CHECK (
  CASE WHEN action IN ('reserve_expiring', 'late_action_ignored', 'deadline_extended')
    THEN to_status IS NULL
    ELSE to_status IS NOT NULL AND (action = 'create') = (from_status IS NULL)
  END
);
ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'close_late', 'admin_close',
  'cancel', 'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored',
  'deadline_extended', 'admin_cancel'
));

DROP INDEX customer_order_supply_overdue_idx;
DROP INDEX customer_order_term_answer_by_idx;
DROP INDEX customer_order_user_offer_idx;
CREATE INDEX customer_order_user_offer_idx ON customer_order (user_account_id, offer_id)
  WHERE status IN ('created', 'accepted', 'ready');

UPDATE customer_order
SET status = 'cancelled_by_user',
    finished_at = COALESCE(finished_at, now()),
    code_released_at = COALESCE(code_released_at, now())
WHERE status IN ('term_proposed', 'term_expired');

ALTER TABLE customer_order DROP CONSTRAINT customer_order_accepted_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_accepted_check CHECK (
  (accepted_at IS NULL) = (phone_revealed_at IS NULL)
  AND (status <> 'created' OR accepted_at IS NULL)
  AND (status NOT IN ('accepted', 'ready', 'reserve_expired') OR accepted_at IS NOT NULL)
  AND (status <> 'completed' OR accepted_at IS NOT NULL OR close_method = 'admin')
);
ALTER TABLE customer_order DROP CONSTRAINT customer_order_code_held_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_code_held_check CHECK (
  status NOT IN ('created', 'accepted', 'ready') OR code_released_at IS NULL
);
ALTER TABLE customer_order DROP CONSTRAINT customer_order_finished_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_finished_check CHECK (
  (status IN ('created', 'accepted', 'ready')) = (finished_at IS NULL)
);

ALTER TABLE customer_order
  DROP CONSTRAINT customer_order_term_check,
  DROP COLUMN supply_overdue_noted_at,
  DROP COLUMN supply_overdue_at,
  DROP COLUMN confirmed_lead_days,
  DROP COLUMN term_answer_by,
  DROP COLUMN term_proposed_at,
  DROP COLUMN proposed_ready_on,
  DROP COLUMN proposed_lead_days,
  DROP COLUMN expected_ready_on;

UPDATE customer_order SET kind = 'stock' WHERE kind = 'on_order';

ALTER TABLE customer_order DROP CONSTRAINT customer_order_status_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_status_check CHECK (status IN (
  'created', 'accepted', 'ready', 'completed',
  'cancelled_by_user', 'declined_by_supplier', 'response_expired', 'reserve_expired',
  'cancelled_by_admin'
));
ALTER TABLE customer_order DROP CONSTRAINT customer_order_kind_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_kind_check CHECK (kind IN ('stock'));

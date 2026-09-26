-- Up Migration
-- Notices of orders to suppliers, their buttons, the outage of the channel
-- and deadlines extended by an administrator (ARCHITECTURE.md 5.11, 6.6,
-- 9.1, 4.36; TASK-025; PRODUCT 8.4, 10.1, 10.4, 12.6, 15; SCREENS 8.5
-- W-01…W-04, A-ORD-02, A-ORD-03, A-HOME).
--
-- A new order goes to the employees of its supplier as a WhatsApp message
-- with the buttons «Подтвердить» and «Отказать». Each button carries a
-- payload the server signed: which order, which action, and which employee
-- the message was addressed to. A press is applied by the same state machine
-- as a button of the cabinet, once, and what was decided about it stays on
-- the press. When the channel stops delivering, the administrator gets one
-- signal and may extend the deadlines by hand, with a reason — a timer is
-- never extended by itself.

-- The payloads of the quick replies of a message, by the button's name. Our
-- own tokens (an order, an employee, an expiry and a signature), not
-- personal data: kept as the delivery log keeps the rest.
ALTER TABLE outbound_message ADD COLUMN button_payloads JSONB;

-- What the detector of an outage reads every minute: the notices of orders
-- of the last minutes.
CREATE INDEX outbound_message_subject_created_idx ON outbound_message (subject_type, created_at);

-- What was decided about a press. `applied_at` (TASK-024) is when it was
-- dealt with; `outcome` is how — and a press that was not applied (a forged
-- or expired payload, another number, a removed employee) keeps its outcome
-- all the same: nothing is thrown away.
ALTER TABLE message_button_press ADD COLUMN outcome TEXT;
-- A press stored before this migration answered a message whose buttons
-- carried no payload the server signed (TASK-024 sent none), so none of them
-- can ever be applied: each is decided now, as what it is.
UPDATE message_button_press
  SET applied_at = coalesce(applied_at, now()), outcome = 'invalid_payload';
ALTER TABLE message_button_press
  ADD CONSTRAINT message_button_press_outcome_check CHECK (
    outcome IS NULL OR outcome IN (
      'accepted', 'declined', 'repeated', 'conflict', 'member_removed',
      'invalid_payload', 'expired', 'phone_mismatch', 'foreign_message', 'no_handler'
    )
  ),
  ADD CONSTRAINT message_button_press_applied_check CHECK ((applied_at IS NULL) = (outcome IS NULL));

-- The administrator extends a deadline of an order (A-ORD-02, A-ORD-03): a
-- note of the journal, not a move of the state machine.
ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'close_late', 'admin_close',
  'cancel', 'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored',
  'deadline_extended'
));
-- …and it is a note: it moves nothing, so it names no status.
ALTER TABLE order_event DROP CONSTRAINT order_event_move_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_move_check CHECK (
  CASE WHEN action IN ('reserve_expiring', 'late_action_ignored', 'deadline_extended')
    THEN to_status IS NULL
    ELSE to_status IS NOT NULL AND (action = 'create') = (from_status IS NULL)
  END
);

-- A signal can be about the channel of notices itself (the outage of 6.6),
-- and a signal ends: the detector closes it when the channel delivers again.
ALTER TABLE admin_signal DROP CONSTRAINT admin_signal_subject_check;
ALTER TABLE admin_signal ADD COLUMN closed_at TIMESTAMPTZ;
-- Nothing closed a signal before; one closed by hand gets its last sighting.
UPDATE admin_signal SET closed_at = last_seen_at WHERE status = 'closed';
ALTER TABLE admin_signal
  ADD CONSTRAINT admin_signal_subject_check CHECK (subject_type IN ('order', 'supplier', 'channel')),
  ADD CONSTRAINT admin_signal_closed_check CHECK ((status = 'closed') = (closed_at IS NOT NULL));
-- The latest closed signal of a subject: where the detector starts counting
-- again, so failures a closed signal already told about are not told twice.
CREATE INDEX admin_signal_closed_idx ON admin_signal (kind, subject_type, subject_id, closed_at DESC)
  WHERE status = 'closed';

-- Down Migration
DROP INDEX admin_signal_closed_idx;
-- Signals about the channel have no place in the old rules.
DELETE FROM admin_signal WHERE subject_type = 'channel';
ALTER TABLE admin_signal
  DROP CONSTRAINT admin_signal_closed_check,
  DROP COLUMN closed_at,
  DROP CONSTRAINT admin_signal_subject_check;
ALTER TABLE admin_signal
  ADD CONSTRAINT admin_signal_subject_check CHECK (subject_type IN ('order', 'supplier'));

-- The journal is append-only (a trigger forbids UPDATE and DELETE): with
-- notes of extensions in it the old rule can't come back, and the rollback
-- refuses rather than lose them (as the rollback of `close-orders` does).
ALTER TABLE order_event DROP CONSTRAINT order_event_move_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_move_check CHECK (
  CASE WHEN action IN ('reserve_expiring', 'late_action_ignored')
    THEN to_status IS NULL
    ELSE to_status IS NOT NULL AND (action = 'create') = (from_status IS NULL)
  END
);
ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'close_late', 'admin_close',
  'cancel', 'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored'
));

ALTER TABLE message_button_press
  DROP CONSTRAINT message_button_press_applied_check,
  DROP CONSTRAINT message_button_press_outcome_check,
  DROP COLUMN outcome;

DROP INDEX outbound_message_subject_created_idx;
ALTER TABLE outbound_message DROP COLUMN button_payloads;

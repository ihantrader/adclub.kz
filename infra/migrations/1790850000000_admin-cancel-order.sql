-- Up Migration
-- The administrator cancels an order still going on (TASK-036.B; SCREENS
-- A-ORD-02 «Отменить заявку»; ARCHITECTURE 4.57): a move of the state
-- machine of its own, `admin_cancel`, to a final status of its own,
-- `cancelled_by_admin` — the supplier and the user read «Отменена
-- администратором», never «Клиент отменил». Who cancelled and why is kept on
-- the order (the reason is the administrator's to see) and the database
-- holds the rule: the status and only it has both, and the reason is not
-- blank.

ALTER TABLE customer_order DROP CONSTRAINT customer_order_status_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_status_check CHECK (status IN (
  'created', 'accepted', 'ready', 'completed',
  'cancelled_by_user', 'declined_by_supplier', 'response_expired', 'reserve_expired',
  'cancelled_by_admin'
));

ALTER TABLE customer_order
  ADD COLUMN cancelled_by_admin_id UUID REFERENCES admin_user (id),
  ADD COLUMN cancel_reason TEXT,
  ADD CONSTRAINT customer_order_admin_cancel_check CHECK (
    (status = 'cancelled_by_admin') = (cancelled_by_admin_id IS NOT NULL)
    AND (cancelled_by_admin_id IS NULL) = (cancel_reason IS NULL)
    AND (cancel_reason IS NULL OR length(btrim(cancel_reason)) > 0)
  );

ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'close_late', 'admin_close',
  'cancel', 'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored',
  'deadline_extended', 'admin_cancel'
));

-- Down Migration
-- The old rules know no administrator's cancel: such an order reads as
-- cancelled (the only cancel they know), its journal entry as a cancel. The
-- journal is append-only, so its trigger steps aside for this one rewrite.
ALTER TABLE order_event DISABLE TRIGGER order_event_immutable;
UPDATE order_event SET action = 'cancel' WHERE action = 'admin_cancel';
UPDATE order_event SET to_status = 'cancelled_by_user' WHERE to_status = 'cancelled_by_admin';
UPDATE order_event SET from_status = 'cancelled_by_user' WHERE from_status = 'cancelled_by_admin';
ALTER TABLE order_event ENABLE TRIGGER order_event_immutable;

ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'close_late', 'admin_close',
  'cancel', 'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored',
  'deadline_extended'
));

UPDATE customer_order
SET status = 'cancelled_by_user', cancelled_by_admin_id = NULL, cancel_reason = NULL
WHERE status = 'cancelled_by_admin';

ALTER TABLE customer_order
  DROP CONSTRAINT customer_order_admin_cancel_check,
  DROP COLUMN cancel_reason,
  DROP COLUMN cancelled_by_admin_id;

ALTER TABLE customer_order DROP CONSTRAINT customer_order_status_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_status_check CHECK (status IN (
  'created', 'accepted', 'ready', 'completed',
  'cancelled_by_user', 'declined_by_supplier', 'response_expired', 'reserve_expired'
));

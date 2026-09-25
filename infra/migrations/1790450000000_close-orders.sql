-- Up Migration
-- Giving an order out, the late close window, the discipline of users and
-- the signals to the administrator (ARCHITECTURE.md 5.7, 5.11, 6.1, 6.5,
-- 4.32; TASK-022; PRODUCT 10.1, 10.5, 10.7; D-043).
--
-- An order reaches «Выдана» in exactly two ways: an employee of its own
-- company presents the code or the QR the customer shows, or the
-- administrator closes a disputed order without a code and with a reason.
-- Both are recorded on the order itself — when, how, by whom, and whether
-- it was closed after its time had run out.
--
-- The confirmation code must not be guessable and must not be handed to
-- another order while the first one can still be closed. Until now the code
-- was unique among the active statuses only, so an expired order released
-- it at once — and an expired reserve can still be closed for the whole
-- late close window. The code is therefore held by the order until it is
-- released explicitly (`code_released_at`), and the unique index stands on
-- that: a code points at one order for as long as that order can be given
-- out. The sweeper releases the code once the window has passed.

ALTER TABLE customer_order
  -- When, how and by whom the order was given out.
  ADD COLUMN closed_at TIMESTAMPTZ,
  ADD COLUMN close_method TEXT,
  ADD COLUMN closed_by_member_id UUID,
  ADD COLUMN closed_by_admin_id UUID REFERENCES admin_user (id),
  -- Given out inside the late close window (PRODUCT 10.7).
  ADD COLUMN closed_late BOOLEAN NOT NULL DEFAULT false,
  -- Why the administrator closed it without a code (D-043); their view only.
  ADD COLUMN close_reason TEXT,
  -- The end of the late close window, fixed when the pickup reserve expired.
  ADD COLUMN late_close_until TIMESTAMPTZ,
  -- Until this is set, the confirmation code of this order is its own.
  ADD COLUMN code_released_at TIMESTAMPTZ,
  ADD CONSTRAINT customer_order_closed_by_fkey FOREIGN KEY (closed_by_member_id, supplier_id)
    REFERENCES supplier_member (id, supplier_id),
  ADD CONSTRAINT customer_order_close_check CHECK (
    (status = 'completed') = (closed_at IS NOT NULL)
    AND (closed_at IS NULL) = (close_method IS NULL)
    AND (close_method IS NULL OR close_method IN ('qr', 'code', 'admin'))
    -- The code and the QR name an employee; the administrator names themselves.
    AND (closed_by_member_id IS NOT NULL) = (COALESCE(close_method, '') IN ('qr', 'code'))
    AND (closed_by_admin_id IS NOT NULL) = (COALESCE(close_method, '') = 'admin')
    -- A close without a code always says why; the other two never do.
    AND (close_reason IS NOT NULL) = (COALESCE(close_method, '') = 'admin')
    AND (NOT closed_late OR closed_at IS NOT NULL)
  ),
  -- An order still going on never lets go of its code.
  ADD CONSTRAINT customer_order_code_held_check CHECK (
    status NOT IN ('created', 'accepted', 'ready') OR code_released_at IS NULL
  );

-- «Выдана» used to mean the supplier had accepted the order first. The
-- administrator closes a disputed order the supplier never answered too
-- («поставщик не ответил, но товар выдал», D-043) — and that close must not
-- pretend the customer's phone was ever opened to the supplier.
ALTER TABLE customer_order DROP CONSTRAINT customer_order_accepted_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_accepted_check CHECK (
  (accepted_at IS NULL) = (phone_revealed_at IS NULL)
  AND (status <> 'created' OR accepted_at IS NULL)
  AND (status NOT IN ('accepted', 'ready', 'reserve_expired') OR accepted_at IS NOT NULL)
  AND (status <> 'completed' OR accepted_at IS NOT NULL OR close_method = 'admin')
);

-- Orders made before this migration: the codes of the ones already final
-- were free the moment they finished, and stay free; an expired reserve of
-- that time has no window left.
UPDATE customer_order
SET code_released_at = COALESCE(finished_at, now()),
    late_close_until = CASE
      WHEN status = 'reserve_expired' THEN COALESCE(finished_at, now())
      ELSE late_close_until
    END
WHERE status NOT IN ('created', 'accepted', 'ready');

-- An expired reserve always knows how long it may still be closed (checked
-- after the rows above got their window).
ALTER TABLE customer_order ADD CONSTRAINT customer_order_late_close_check
  CHECK (status <> 'reserve_expired' OR late_close_until IS NOT NULL);

-- The code a customer says points at one order for as long as that order
-- can still be given out (and a little longer, until the sweeper releases
-- it — holding a code is safe, releasing it early is not).
DROP INDEX customer_order_active_code_key;
CREATE UNIQUE INDEX customer_order_held_code_key ON customer_order (confirmation_code)
  WHERE code_released_at IS NULL;
-- The sweeper that releases the code once the late close window has passed.
CREATE INDEX customer_order_late_close_idx ON customer_order (late_close_until)
  WHERE status = 'reserve_expired' AND code_released_at IS NULL;
-- A-ORD-01 «Закрыта администратором» and the signal about a supplier with
-- too many such closes (D-043).
CREATE INDEX customer_order_admin_close_idx ON customer_order (supplier_id, closed_at)
  WHERE close_method = 'admin';
-- A-ORD-01 «Закрыта поздно».
CREATE INDEX customer_order_closed_late_idx ON customer_order (created_at DESC, id DESC)
  WHERE closed_late;

-- The key of a creation request is kept only while a repeat of it can
-- still arrive: the cleanup job clears it from orders long finished
-- (TASK-022, debt 7 of TASK-021), so it can't be NOT NULL any more. A
-- cleared key is NULL, and NULLs don't collide in the unique index.
ALTER TABLE customer_order ALTER COLUMN idempotency_key DROP NOT NULL;
CREATE INDEX customer_order_idempotency_cleanup_idx ON customer_order (finished_at)
  WHERE idempotency_key IS NOT NULL AND finished_at IS NOT NULL;

-- Two more moves of the state machine (ARCHITECTURE 6.1, 6.5).
ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'close_late', 'admin_close',
  'cancel', 'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored'
));

-- The club's own discipline statistics of a user (PRODUCT 10.5, 5.7): the
-- pickup reserve of an accepted order ran out and nobody came. The
-- administrator sees it; the user never does, and the supplier's rating
-- never feels it. A late close or a close by the administrator lifts the
-- mark — it is kept as lifted, not deleted (A-USR-02).
CREATE TABLE user_discipline_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id UUID NOT NULL REFERENCES account (id),
  order_id UUID NOT NULL REFERENCES customer_order (id),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  kind TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  -- The administrator's words; the automatic liftings have none.
  revoked_note TEXT,
  revoked_by_admin_id UUID REFERENCES admin_user (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One mark of a kind per order: the sweeper may pass twice.
  CONSTRAINT user_discipline_event_order_key UNIQUE (order_id, kind),
  CONSTRAINT user_discipline_event_kind_check CHECK (kind IN ('pickup_no_show')),
  CONSTRAINT user_discipline_event_revoked_check CHECK (
    (revoked_at IS NULL) = (revoked_by IS NULL)
    AND (revoked_by IS NULL OR revoked_by IN ('late_close', 'admin_close', 'admin'))
    -- Only an administrator's lifting names a person and says why.
    AND (revoked_by_admin_id IS NOT NULL) = (COALESCE(revoked_by, '') = 'admin')
    AND (revoked_note IS NOT NULL) = (COALESCE(revoked_by, '') = 'admin')
  )
);

CREATE INDEX user_discipline_event_user_idx
  ON user_discipline_event (user_account_id, occurred_at DESC, id DESC);
CREATE INDEX user_discipline_event_standing_idx ON user_discipline_event (occurred_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX user_discipline_event_supplier_idx ON user_discipline_event (supplier_id);

-- Signals for a person to look at (ARCHITECTURE 5.11, 6.5, 6.6; A-HOME).
-- The same fact coming up again counts up in one row instead of piling up.
CREATE TABLE admin_signal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  payload JSONB NOT NULL DEFAULT '{}',
  times INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_signal_status_check CHECK (status IN ('open', 'acknowledged', 'closed')),
  CONSTRAINT admin_signal_subject_check CHECK (subject_type IN ('order', 'supplier')),
  CONSTRAINT admin_signal_times_check CHECK (times >= 1)
);

-- One open signal of a kind per subject (the rest is history).
CREATE UNIQUE INDEX admin_signal_open_key ON admin_signal (kind, subject_type, subject_id)
  WHERE status = 'open';
CREATE INDEX admin_signal_last_seen_idx ON admin_signal (last_seen_at DESC, id DESC);

-- Down Migration
DROP TABLE admin_signal;
DROP TABLE user_discipline_event;

ALTER TABLE order_event DROP CONSTRAINT order_event_action_check;
ALTER TABLE order_event ADD CONSTRAINT order_event_action_check CHECK (action IN (
  'create', 'accept', 'decline', 'mark_ready', 'close', 'cancel',
  'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored'
));

DROP INDEX customer_order_idempotency_cleanup_idx;
-- An order whose key the cleanup already cleared gets one back, so the
-- column can be NOT NULL again (it is a key of a request, not of the order).
UPDATE customer_order SET idempotency_key = gen_random_uuid() WHERE idempotency_key IS NULL;
ALTER TABLE customer_order ALTER COLUMN idempotency_key SET NOT NULL;

DROP INDEX customer_order_closed_late_idx;
DROP INDEX customer_order_admin_close_idx;
DROP INDEX customer_order_late_close_idx;
DROP INDEX customer_order_held_code_key;
-- Back to «unique among the active statuses»: an order given out by this
-- task keeps its code, and a code held twice would break the old index.
CREATE UNIQUE INDEX customer_order_active_code_key ON customer_order (confirmation_code)
  WHERE status IN ('created', 'accepted', 'ready');

-- The rules this migration added go first: the rows are about to stop
-- obeying them.
ALTER TABLE customer_order
  DROP CONSTRAINT customer_order_code_held_check,
  DROP CONSTRAINT customer_order_late_close_check,
  DROP CONSTRAINT customer_order_close_check;

-- An order the administrator closed without the supplier's answer would
-- break the old check, so it goes back to «created» — the state it was in
-- before the close this migration made possible.
UPDATE customer_order
SET status = 'created',
    finished_at = NULL,
    closed_at = NULL,
    close_method = NULL,
    closed_by_admin_id = NULL,
    close_reason = NULL,
    closed_late = false,
    code_released_at = NULL
WHERE status = 'completed' AND accepted_at IS NULL;

ALTER TABLE customer_order DROP CONSTRAINT customer_order_accepted_check;
ALTER TABLE customer_order ADD CONSTRAINT customer_order_accepted_check CHECK (
  (accepted_at IS NULL) = (phone_revealed_at IS NULL)
  AND (status <> 'created' OR accepted_at IS NULL)
  AND (status NOT IN ('accepted', 'ready', 'completed', 'reserve_expired')
    OR accepted_at IS NOT NULL)
);

ALTER TABLE customer_order
  DROP CONSTRAINT customer_order_closed_by_fkey,
  DROP COLUMN code_released_at,
  DROP COLUMN late_close_until,
  DROP COLUMN close_reason,
  DROP COLUMN closed_late,
  DROP COLUMN closed_by_admin_id,
  DROP COLUMN closed_by_member_id,
  DROP COLUMN close_method,
  DROP COLUMN closed_at;

-- Up Migration
-- Orders on items in stock and their journal (ARCHITECTURE.md 5.7, 6.1,
-- 4.31; TASK-021; PRODUCT 10.1, 10.2, 10.4, 12.6).
--
-- A user orders from one offer of one supplier: the order keeps a copy of
-- the offer's terms (the snapshot) and never follows later changes of the
-- offer. The supplier's answer is due by `respond_by`; an accepted pickup
-- order is reserved until `expires_at`. Every move of the state machine is
-- one conditional update of the row (the status it starts from) plus one
-- entry of `order_event` in the same transaction; the journal is
-- append-only. Nothing is ever deleted.
--
-- The table is `customer_order`, not `order` (ARCHITECTURE 5.7): ORDER is
-- a reserved word of SQL, and every raw query would have to quote it.

-- «№ 1001»: numbers to say on the phone and to search by.
CREATE SEQUENCE customer_order_number_seq START WITH 1001;

CREATE TABLE customer_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number BIGINT NOT NULL DEFAULT nextval('customer_order_number_seq'),
  kind TEXT NOT NULL DEFAULT 'stock',
  user_account_id UUID NOT NULL REFERENCES account (id),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  location_id UUID NOT NULL,
  offer_id UUID NOT NULL REFERENCES offer (id),
  item_id UUID NOT NULL REFERENCES catalog_item (id),
  -- The offer as it was when the order was created (`OfferSnapshot`).
  offer_snapshot JSONB NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  total BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KZT',
  fulfillment TEXT NOT NULL,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  -- An employee's order with their own company (PRODUCT 12.6).
  is_test BOOLEAN NOT NULL DEFAULT false,
  -- Known to the user only; unique among active orders (index below).
  confirmation_code TEXT NOT NULL,
  -- The content of the QR: 128 random bits.
  qr_token TEXT NOT NULL,
  -- The app's key of this order: sent again, it finds this order.
  idempotency_key UUID NOT NULL,
  respond_by TIMESTAMPTZ NOT NULL,
  -- The end of the pickup reserve; none for delivery.
  expires_at TIMESTAMPTZ,
  reserve_warn_at TIMESTAMPTZ,
  reserve_warned_at TIMESTAMPTZ,
  -- The receipt date promised when accepted, in the point's time zone.
  receipt_on DATE,
  accepted_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  phone_revealed_at TIMESTAMPTZ,
  -- The employee who accepted or declined it.
  handled_by_member_id UUID,
  handled_at TIMESTAMPTZ,
  decline_reason TEXT,
  decline_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT customer_order_number_key UNIQUE (number),
  CONSTRAINT customer_order_qr_token_key UNIQUE (qr_token),
  CONSTRAINT customer_order_idempotency_key UNIQUE (user_account_id, idempotency_key),
  CONSTRAINT customer_order_location_fkey FOREIGN KEY (location_id, supplier_id)
    REFERENCES supplier_location (id, supplier_id),
  CONSTRAINT customer_order_handled_by_fkey FOREIGN KEY (handled_by_member_id, supplier_id)
    REFERENCES supplier_member (id, supplier_id),
  CONSTRAINT customer_order_kind_check CHECK (kind IN ('stock')),
  CONSTRAINT customer_order_status_check CHECK (status IN (
    'created', 'accepted', 'ready', 'completed',
    'cancelled_by_user', 'declined_by_supplier', 'response_expired', 'reserve_expired'
  )),
  CONSTRAINT customer_order_fulfillment_check CHECK (fulfillment IN ('pickup', 'delivery')),
  CONSTRAINT customer_order_money_check CHECK (
    unit_price > 0 AND quantity BETWEEN 1 AND 999 AND total = unit_price::bigint * quantity
  ),
  CONSTRAINT customer_order_currency_check CHECK (currency = 'KZT'),
  CONSTRAINT customer_order_comment_check
    CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 500),
  CONSTRAINT customer_order_code_check CHECK (confirmation_code ~ '^[0-9]{6}$'),
  CONSTRAINT customer_order_decline_check CHECK (
    (decline_reason IS NULL OR decline_reason IN ('out_of_stock', 'cannot_meet_term', 'other'))
    AND (status = 'declined_by_supplier' OR (decline_reason IS NULL AND decline_note IS NULL))
  ),
  -- Accepted — and only accepted — orders opened the customer's phone.
  CONSTRAINT customer_order_accepted_check CHECK (
    (accepted_at IS NULL) = (phone_revealed_at IS NULL)
    AND (status <> 'created' OR accepted_at IS NULL)
    AND (status NOT IN ('accepted', 'ready', 'completed', 'reserve_expired')
      OR accepted_at IS NOT NULL)
  ),
  -- A reserve is for pickup only, and its warning goes with it.
  CONSTRAINT customer_order_reserve_check CHECK (
    (expires_at IS NULL OR fulfillment = 'pickup')
    AND (expires_at IS NULL) = (reserve_warn_at IS NULL)
    AND (reserve_warned_at IS NULL OR reserve_warn_at IS NOT NULL)
  ),
  CONSTRAINT customer_order_finished_check CHECK (
    (status IN ('created', 'accepted', 'ready')) = (finished_at IS NULL)
  ),
  CONSTRAINT customer_order_handled_check
    CHECK ((handled_by_member_id IS NULL) = (handled_at IS NULL))
);

-- The code a user says at the counter points to one active order.
CREATE UNIQUE INDEX customer_order_active_code_key ON customer_order (confirmation_code)
  WHERE status IN ('created', 'accepted', 'ready');
-- The user's lists and «an active order on this offer already».
CREATE INDEX customer_order_user_idx ON customer_order (user_account_id, created_at DESC, id DESC);
CREATE INDEX customer_order_user_offer_idx ON customer_order (user_account_id, offer_id)
  WHERE status IN ('created', 'accepted', 'ready');
-- The cabinet's tabs.
CREATE INDEX customer_order_supplier_idx
  ON customer_order (supplier_id, status, created_at DESC, id DESC);
-- The admin list.
CREATE INDEX customer_order_created_idx ON customer_order (created_at DESC, id DESC);
-- The deadline sweeper: each due condition has its index.
CREATE INDEX customer_order_respond_by_idx ON customer_order (respond_by)
  WHERE status = 'created';
CREATE INDEX customer_order_expires_at_idx ON customer_order (expires_at)
  WHERE status IN ('accepted', 'ready') AND expires_at IS NOT NULL;
CREATE INDEX customer_order_reserve_warn_idx ON customer_order (reserve_warn_at)
  WHERE status IN ('accepted', 'ready') AND reserve_warned_at IS NULL;

CREATE TABLE order_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The order of entries of one order, whatever their time.
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  order_id UUID NOT NULL REFERENCES customer_order (id),
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_type TEXT NOT NULL,
  actor_account_id UUID REFERENCES account (id),
  -- An employee, removed ones too: the history keeps who acted.
  actor_member_id UUID REFERENCES supplier_member (id),
  actor_admin_id UUID REFERENCES admin_user (id),
  channel TEXT NOT NULL,
  -- Details only (quantity, reason, deadline); never the code or a phone.
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_event_seq_key UNIQUE (seq),
  CONSTRAINT order_event_action_check CHECK (action IN (
    'create', 'accept', 'decline', 'mark_ready', 'close', 'cancel',
    'expire_no_response', 'expire_reserve', 'reserve_expiring', 'late_action_ignored'
  )),
  -- A move names where from and where to; a note moves nothing.
  CONSTRAINT order_event_move_check CHECK (
    CASE WHEN action IN ('reserve_expiring', 'late_action_ignored')
      THEN to_status IS NULL
      ELSE to_status IS NOT NULL AND (action = 'create') = (from_status IS NULL)
    END
  ),
  CONSTRAINT order_event_actor_check CHECK (
    (actor_type = 'user' AND actor_account_id IS NOT NULL
      AND actor_member_id IS NULL AND actor_admin_id IS NULL)
    OR (actor_type = 'supplier_member' AND actor_account_id IS NOT NULL
      AND actor_member_id IS NOT NULL AND actor_admin_id IS NULL)
    OR (actor_type = 'admin' AND actor_account_id IS NOT NULL
      AND actor_member_id IS NULL AND actor_admin_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_account_id IS NULL
      AND actor_member_id IS NULL AND actor_admin_id IS NULL)
  ),
  CONSTRAINT order_event_channel_check
    CHECK (channel IN ('app', 'supplier_web', 'admin', 'timer', 'whatsapp'))
);

CREATE INDEX order_event_order_idx ON order_event (order_id, seq);

-- Append-only, like the action journal: an entry can't be changed or
-- removed through the application (TRUNCATE, used by tests, is not a row
-- operation).
CREATE FUNCTION order_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_event is append-only';
END;
$$;

CREATE TRIGGER order_event_immutable
  BEFORE UPDATE OR DELETE ON order_event
  FOR EACH ROW EXECUTE FUNCTION order_event_immutable();

-- Down Migration
DROP TABLE order_event;
DROP FUNCTION order_event_immutable();
DROP TABLE customer_order;
DROP SEQUENCE customer_order_number_seq;

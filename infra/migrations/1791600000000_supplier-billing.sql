-- Up Migration
-- A supplier's card subscription (EPIC-14, TASK-042; PRODUCT 14.1, 14.3; ARCHITECTURE
-- 9.4.2, 18.5, 4.77; D-041).
--
-- 1. Two pauses that live apart. `supplier.pause_reason` was one column: a company the
--    administrator paused and then the billing too (or the other way round) kept one of
--    them, and lifting it lifted both. Now the administrator's pause
--    (`admin_paused_at`, `admin_pause_note`) and the billing one (`billing_paused_at`) are
--    columns of their own; `status` is still what they make it (one predicate for the
--    showcase). Nothing is lost: a paused company keeps the reason it had.
--
-- 2. The card: `payment_method` (the provider's token sealed, the mask and the brand open;
--    one active card per company), `card_binding` (a company's trip to the provider's page
--    and back; one open at a time), `payment_attempt` (one charge at the provider by an
--    idempotency key; at most one success and one open attempt per period — the database
--    keeps «not twice for a period» so no race, retry or second worker can charge twice),
--    `payment_webhook_event` (the provider's deliveries, idempotent by their id).

ALTER TABLE supplier
  ADD COLUMN admin_paused_at TIMESTAMPTZ,
  ADD COLUMN admin_pause_note TEXT,
  ADD COLUMN billing_paused_at TIMESTAMPTZ;

UPDATE supplier SET
  admin_paused_at = CASE WHEN pause_reason = 'admin' THEN paused_at END,
  admin_pause_note = CASE WHEN pause_reason = 'admin' THEN pause_note END,
  billing_paused_at = CASE WHEN pause_reason = 'billing' THEN paused_at END;

ALTER TABLE supplier
  DROP CONSTRAINT supplier_status_check,
  DROP CONSTRAINT supplier_pause_reason_check,
  DROP CONSTRAINT supplier_paused_check;

ALTER TABLE supplier
  DROP COLUMN pause_reason,
  DROP COLUMN pause_note,
  DROP COLUMN paused_at;

ALTER TABLE supplier
  ADD CONSTRAINT supplier_status_check CHECK (
    status = CASE
      WHEN blocked_at IS NOT NULL THEN 'blocked'
      WHEN admin_paused_at IS NOT NULL OR billing_paused_at IS NOT NULL THEN 'paused'
      ELSE 'active'
    END
  );

CREATE TABLE card_binding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  provider TEXT NOT NULL,
  -- The provider's own id of the session (its page, its order).
  provider_ref TEXT NOT NULL,
  -- Where the provider sends the browser back to; an address of the cabinet.
  return_url TEXT NOT NULL,
  -- The provider's page the browser was sent to (kept to give the same trip again).
  redirect_url TEXT,
  -- pending — the page is open; card_received — the provider named a card;
  -- charging — the first charge is on its way; completed — the card is linked;
  -- declined — the bank refused the first charge; failed — it could not be done
  -- (the provider was unavailable, the page said no); abandoned — nobody came back.
  status TEXT NOT NULL DEFAULT 'pending',
  -- A decline reason (`insufficient_funds`…) or `provider_unavailable`, `cancelled`, `expired`.
  failure TEXT,
  started_by_member_id UUID,
  -- What the provider handed over: the token (sealed), and what is shown of the card.
  card_token_sealed TEXT,
  card_mask TEXT,
  card_brand TEXT,
  card_exp_month SMALLINT,
  card_exp_year SMALLINT,
  payment_method_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT card_binding_provider_check CHECK (provider IN ('card_kz', 'test')),
  CONSTRAINT card_binding_status_check CHECK (
    status IN ('pending', 'card_received', 'charging', 'completed', 'declined', 'failed', 'abandoned')
  ),
  CONSTRAINT card_binding_finished_check CHECK (
    (status IN ('completed', 'declined', 'failed', 'abandoned')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT card_binding_ref_key UNIQUE (provider, provider_ref)
);

-- One open trip to the provider's page per company.
CREATE UNIQUE INDEX card_binding_open_key ON card_binding (supplier_id)
  WHERE status IN ('pending', 'card_received', 'charging');
CREATE INDEX card_binding_expiry_idx ON card_binding (expires_at)
  WHERE status IN ('pending', 'card_received');

CREATE TABLE payment_method (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  provider TEXT NOT NULL,
  -- The provider's token for the card, AES-256-GCM bound to this row's id. The card's
  -- number, term and code never reach our server: the provider's page takes them.
  token_sealed TEXT NOT NULL,
  mask TEXT NOT NULL,
  brand TEXT NOT NULL,
  exp_month SMALLINT NOT NULL,
  exp_year SMALLINT NOT NULL,
  -- active — the card the subscription is charged to; replaced — an earlier card
  -- (its token is detached at the provider); removed — taken off by the operator.
  status TEXT NOT NULL DEFAULT 'active',
  binding_id UUID REFERENCES card_binding (id),
  linked_by_member_id UUID,
  detached_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_at TIMESTAMPTZ,
  CONSTRAINT payment_method_provider_check CHECK (provider IN ('card_kz', 'test')),
  CONSTRAINT payment_method_mask_check CHECK (mask ~ '^[0-9]{4}$'),
  CONSTRAINT payment_method_exp_check CHECK (exp_month BETWEEN 1 AND 12 AND exp_year BETWEEN 2000 AND 2200),
  CONSTRAINT payment_method_status_check CHECK (status IN ('active', 'replaced', 'removed')),
  CONSTRAINT payment_method_replaced_check CHECK ((status = 'active') = (replaced_at IS NULL))
);

CREATE UNIQUE INDEX payment_method_active_key ON payment_method (supplier_id) WHERE status = 'active';
CREATE INDEX payment_method_detach_idx ON payment_method (replaced_at)
  WHERE status <> 'active' AND detached_at IS NULL;

ALTER TABLE card_binding
  ADD CONSTRAINT card_binding_payment_method_fkey FOREIGN KEY (payment_method_id) REFERENCES payment_method (id);

CREATE TABLE payment_attempt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  -- NULL for the first charge: the subscription is born of its success.
  subscription_id UUID REFERENCES subscription (id),
  binding_id UUID REFERENCES card_binding (id),
  -- NULL for the first charge: the token is still the binding's.
  payment_method_id UUID REFERENCES payment_method (id),
  plan_id UUID REFERENCES plan (id),
  -- first — the charge that links the card; scheduled — the daily job at the end of a
  -- term; retry — the daily job after a refusal; manual — «Оплатить сейчас».
  kind TEXT NOT NULL,
  -- What is paid once: `bind:<binding>` or `<subscription>:<where the paid term began>`.
  period_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  -- The provider's own key of «this one payment»: the same key is the same payment.
  idempotency_key TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KZT',
  period_from TIMESTAMPTZ NOT NULL,
  period_to TIMESTAMPTZ NOT NULL,
  anchor_day SMALLINT NOT NULL,
  -- created — about to be sent or in flight; unavailable — the provider could not take it
  -- (not charged for sure, retried in an hour); unknown — the request may have reached it
  -- (looked up by the key before anything is sent again); succeeded / declined — final;
  -- cancelled — a first charge the provider could not take, given up (nothing was charged).
  status TEXT NOT NULL DEFAULT 'created',
  decline_reason TEXT,
  provider TEXT NOT NULL,
  provider_payment_id TEXT,
  claimed_until TIMESTAMPTZ,
  next_try_at TIMESTAMPTZ,
  tries INTEGER NOT NULL DEFAULT 0,
  -- When the provider first failed this attempt (could not take it, or its answer was lost)
  -- and the latest time: the detector of «Платёжная система недоступна» reads them.
  first_failure_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  requested_by_member_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT payment_attempt_kind_check CHECK (kind IN ('first', 'scheduled', 'retry', 'manual')),
  CONSTRAINT payment_attempt_provider_check CHECK (provider IN ('card_kz', 'test')),
  CONSTRAINT payment_attempt_status_check CHECK (
    status IN ('created', 'unavailable', 'unknown', 'succeeded', 'declined', 'cancelled')
  ),
  CONSTRAINT payment_attempt_amount_check CHECK (amount > 0),
  CONSTRAINT payment_attempt_currency_check CHECK (currency = 'KZT'),
  CONSTRAINT payment_attempt_period_check CHECK (period_to > period_from),
  CONSTRAINT payment_attempt_anchor_check CHECK (anchor_day BETWEEN 1 AND 31),
  CONSTRAINT payment_attempt_number_check CHECK (attempt_no >= 1),
  CONSTRAINT payment_attempt_resolved_check CHECK (
    (status IN ('succeeded', 'declined', 'cancelled')) = (resolved_at IS NOT NULL)
  ),
  CONSTRAINT payment_attempt_decline_check CHECK ((status = 'declined') = (decline_reason IS NOT NULL)),
  CONSTRAINT payment_attempt_source_check CHECK (
    (kind = 'first' AND binding_id IS NOT NULL) OR (kind <> 'first' AND subscription_id IS NOT NULL AND payment_method_id IS NOT NULL)
  ),
  CONSTRAINT payment_attempt_key_key UNIQUE (idempotency_key),
  CONSTRAINT payment_attempt_number_key UNIQUE (period_key, attempt_no)
);

-- «Not twice for a period»: one success, and one attempt in flight at a time.
CREATE UNIQUE INDEX payment_attempt_succeeded_key ON payment_attempt (period_key) WHERE status = 'succeeded';
CREATE UNIQUE INDEX payment_attempt_open_key ON payment_attempt (period_key)
  WHERE status IN ('created', 'unavailable', 'unknown');
CREATE INDEX payment_attempt_supplier_idx ON payment_attempt (supplier_id, created_at DESC, id DESC);
CREATE INDEX payment_attempt_retry_idx ON payment_attempt (next_try_at)
  WHERE status IN ('created', 'unavailable', 'unknown');
CREATE INDEX payment_attempt_subscription_idx ON payment_attempt (subscription_id, created_at DESC);

CREATE TABLE payment_webhook_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  -- card_bound — the provider named the card of a binding; card_cancelled — the person left
  -- its page without one; payment — a charge's result.
  kind TEXT NOT NULL,
  -- The event in our words; a card token in it is sealed, never plain.
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  -- applied / no_effect (a duplicate or stale word) / unknown_reference.
  result TEXT,
  CONSTRAINT payment_webhook_event_provider_check CHECK (provider IN ('card_kz', 'test')),
  CONSTRAINT payment_webhook_event_kind_check CHECK (kind IN ('card_bound', 'card_cancelled', 'payment')),
  CONSTRAINT payment_webhook_event_id_key UNIQUE (provider, provider_event_id)
);

CREATE INDEX payment_webhook_event_pending_idx ON payment_webhook_event (received_at)
  WHERE processed_at IS NULL;

-- Down Migration
DROP TABLE payment_webhook_event;
DROP TABLE payment_attempt;
ALTER TABLE card_binding DROP CONSTRAINT card_binding_payment_method_fkey;
DROP TABLE payment_method;
DROP TABLE card_binding;

ALTER TABLE supplier
  DROP CONSTRAINT supplier_status_check,
  ADD COLUMN pause_reason TEXT,
  ADD COLUMN pause_note TEXT,
  ADD COLUMN paused_at TIMESTAMPTZ;

-- One column can keep one reason: a company paused for both keeps the administrator's.
UPDATE supplier SET
  pause_reason = CASE
    WHEN admin_paused_at IS NOT NULL THEN 'admin'
    WHEN billing_paused_at IS NOT NULL THEN 'billing'
  END,
  pause_note = admin_pause_note,
  paused_at = coalesce(admin_paused_at, billing_paused_at);

ALTER TABLE supplier
  DROP COLUMN admin_paused_at,
  DROP COLUMN admin_pause_note,
  DROP COLUMN billing_paused_at,
  ADD CONSTRAINT supplier_pause_reason_check CHECK (pause_reason IS NULL OR pause_reason IN ('billing', 'admin')),
  ADD CONSTRAINT supplier_paused_check CHECK ((pause_reason IS NULL) = (paused_at IS NULL)),
  ADD CONSTRAINT supplier_status_check CHECK (
    status = CASE
      WHEN blocked_at IS NOT NULL THEN 'blocked'
      WHEN paused_at IS NOT NULL THEN 'paused'
      ELSE 'active'
    END
  );

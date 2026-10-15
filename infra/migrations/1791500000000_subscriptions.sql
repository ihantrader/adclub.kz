-- Up Migration
-- Subscriptions (EPIC-14, TASK-040; PRODUCT 14; ARCHITECTURE 5.10, 9.4.1, 9.4.2,
-- 4.72; D-041, D-059, U-5).
--
-- `plan` — tariffs as records with dates: a rise is a new record with a future
-- `valid_from`, announced `announce_before_days` before it. The tariff in
-- effect on a date and the announced one are two functions of
-- `@adclub/domain` (`planInEffect`, `announcedPlan`).
--
-- `subscription` — a user's (a store's, TASK-041) or a supplier's (a card
-- processor's, TASK-042), one purchase at its provider (`provider_ref`) each.
-- Its status is decided by the server alone, from the provider's events and
-- from time, by one table of moves (`subscriptionTransition`). An account (a
-- company) has at most one current subscription — every status but `expired`
-- — a partial unique index. `unconfirmed_since` — the moment the term (or
-- the grace) passed without a word from the store: `expired_unconfirmed`
-- still gives access `store_lag_tolerance_hours` from it (U-5).
--
-- `billing_event` — every event that moves a subscription, as received: a
-- provider's (idempotent by its id at the provider), the test provider's
-- entered by the operator command, and time's (the sweeper, with an id of
-- its own made of the subscription, the event and its moment). Applied by
-- a background job, in the order of the events' own time; what each one
-- did is kept on it (`outcome`, `detail`, the statuses before and after).
--
-- `supplier.card_linked_at` — the company has linked a card (D-041): its
-- offers are on the showcase only with it, while the switch
-- `supplier_card_required` is on. Set by the operator command of development
-- and tests until TASK-042 keeps it with the card itself.

CREATE TABLE plan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience TEXT NOT NULL,
  code TEXT NOT NULL,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KZT',
  period TEXT NOT NULL DEFAULT 'month',
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  announce_before_days INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_by_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plan_audience_check CHECK (audience IN ('user', 'supplier')),
  CONSTRAINT plan_code_check CHECK (code ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  CONSTRAINT plan_price_check CHECK (price > 0),
  CONSTRAINT plan_currency_check CHECK (currency = 'KZT'),
  CONSTRAINT plan_period_check CHECK (period = 'month'),
  CONSTRAINT plan_dates_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT plan_announce_check CHECK (announce_before_days BETWEEN 0 AND 365),
  CONSTRAINT plan_reason_check CHECK (length(btrim(reason)) > 0),
  CONSTRAINT plan_created_by_check CHECK (created_by_role IN ('operator', 'admin')),
  CONSTRAINT plan_audience_from_key UNIQUE (audience, valid_from)
);

CREATE TABLE subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audience TEXT NOT NULL,
  account_id UUID REFERENCES account (id),
  supplier_id UUID REFERENCES supplier (id),
  plan_id UUID REFERENCES plan (id),
  provider TEXT NOT NULL,
  purchase_platform TEXT,
  provider_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  grace_until TIMESTAMPTZ,
  unconfirmed_since TIMESTAMPTZ,
  last_provider_event_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscription_audience_check CHECK (audience IN ('user', 'supplier')),
  CONSTRAINT subscription_subject_check CHECK (
    (audience = 'user' AND account_id IS NOT NULL AND supplier_id IS NULL)
    OR (audience = 'supplier' AND supplier_id IS NOT NULL AND account_id IS NULL)
  ),
  CONSTRAINT subscription_provider_check CHECK (provider IN ('store', 'card_kz', 'test')),
  CONSTRAINT subscription_platform_check CHECK (
    purchase_platform IS NULL OR purchase_platform IN ('ios', 'android')
  ),
  CONSTRAINT subscription_status_check CHECK (
    (audience = 'user' AND status IN
      ('active', 'grace', 'cancelled', 'expired_unconfirmed', 'suspended', 'expired'))
    OR (audience = 'supplier' AND status IN
      ('active', 'past_due', 'cancelled', 'suspended', 'expired'))
  ),
  CONSTRAINT subscription_unconfirmed_check CHECK (
    (status = 'expired_unconfirmed') = (unconfirmed_since IS NOT NULL)
  ),
  CONSTRAINT subscription_purchase_key UNIQUE (provider, provider_ref)
);

-- One current subscription per account and per company.
CREATE UNIQUE INDEX subscription_current_account_key
  ON subscription (account_id) WHERE status <> 'expired' AND account_id IS NOT NULL;
CREATE UNIQUE INDEX subscription_current_supplier_key
  ON subscription (supplier_id) WHERE status <> 'expired' AND supplier_id IS NOT NULL;
-- The history of an account's subscriptions (the admin card, the last one).
CREATE INDEX subscription_account_idx ON subscription (account_id, created_at DESC);
-- The sweeper: the subscriptions whose moments may come due.
CREATE INDEX subscription_due_idx ON subscription (current_period_end)
  WHERE status IN ('active', 'grace', 'past_due', 'cancelled', 'expired_unconfirmed');

CREATE TABLE billing_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- The purchase the event is about; NULL for time's events (they name the subscription).
  provider_ref TEXT,
  -- The account (or the company) the provider says the purchase is for.
  account_id UUID REFERENCES account (id),
  supplier_id UUID REFERENCES supplier (id),
  subscription_id UUID REFERENCES subscription (id),
  event_at TIMESTAMPTZ NOT NULL,
  -- {periodEnd, graceUntil, platform}: the event in our general words.
  payload JSONB NOT NULL DEFAULT '{}',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  from_status TEXT,
  to_status TEXT,
  applied_at TIMESTAMPTZ,
  CONSTRAINT billing_event_provider_check CHECK (provider IN ('store', 'card_kz', 'test', 'system')),
  CONSTRAINT billing_event_source_check CHECK (source IN ('provider', 'operator', 'system')),
  CONSTRAINT billing_event_system_check CHECK ((provider = 'system') = (source = 'system')),
  CONSTRAINT billing_event_kind_check CHECK (kind IN (
    'started', 'renewed', 'grace_started', 'payment_failed', 'suspended', 'cancelled',
    'cancel_withdrawn', 'expired', 'refunded', 'revoked',
    'period_lapsed', 'grace_lapsed', 'tolerance_lapsed'
  )),
  CONSTRAINT billing_event_outcome_check CHECK (
    outcome IN ('pending', 'applied', 'no_effect', 'refused')
  ),
  CONSTRAINT billing_event_applied_check CHECK ((outcome = 'pending') = (applied_at IS NULL)),
  CONSTRAINT billing_event_id_key UNIQUE (provider, provider_event_id)
);

CREATE INDEX billing_event_subscription_idx ON billing_event (subscription_id, received_at DESC);
CREATE INDEX billing_event_account_idx ON billing_event (account_id, received_at DESC);
CREATE INDEX billing_event_pending_idx ON billing_event (received_at) WHERE outcome = 'pending';

ALTER TABLE supplier ADD COLUMN card_linked_at TIMESTAMPTZ;

-- Down Migration
ALTER TABLE supplier DROP COLUMN card_linked_at;
DROP TABLE billing_event;
DROP TABLE subscription;
DROP TABLE plan;

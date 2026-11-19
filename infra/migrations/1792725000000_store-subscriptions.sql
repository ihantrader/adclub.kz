-- Up Migration
-- A user's subscription through the stores (TASK-041; PRODUCT 14.2, 14.3;
-- ARCHITECTURE 9.4.1, 4.98). The subscription itself, its events and its
-- status machine are TASK-040's (`subscription`, `billing_event`); this adds
-- what only the stores need.
--
-- `plan.store_product_ids` — the products of App Store and Google Play that
-- pay for the tariff. A purchase of a product outside the users' tariff in
-- effect starts no subscription.
--
-- `store_purchase` — one purchase at a store, by our reference of it
-- (`subscription.provider_ref`): `apple:<originalTransactionId>` or
-- `google:<sha-256 of the purchase token>` — the token itself is long and
-- not to be shown, so it is kept here, once, for the calls of the Play
-- Developer API, and never in a reference, a log or the journal. The account
-- the store names (`appAccountToken`, `obfuscatedExternalAccountId`), the
-- environment, the product, and the store's last word about it (what, when)
-- for the administrator; `last_sync_at` — the last successful look at it in
-- the store's API (the hourly reconciliation picks the oldest).
--
-- `store_notification` — every notification a store delivered, once by its
-- id at the store (Apple's `notificationUUID`, Pub/Sub's `messageId`): a
-- known one becomes events of `billing_event` (Apple's at once, Google's
-- after the worker read the purchase's state), an unknown or ignored one is
-- kept with its name and changes nothing. The body itself is not kept.
--
-- `store_api_health` — per store, the last successful and the last failed
-- call of its API: the signal `store_sync_stale` reads it.
--
-- `subscription.grace_reminded_until` — the end of the grace the reminder
-- P-SUB-01 was sent for: one reminder per grace period.

ALTER TABLE plan ADD COLUMN store_product_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE plan ADD CONSTRAINT plan_store_products_check CHECK (
  cardinality(store_product_ids) <= 20
  AND (audience = 'user' OR cardinality(store_product_ids) = 0)
);

ALTER TABLE subscription ADD COLUMN grace_reminded_until TIMESTAMPTZ;

CREATE TABLE store_purchase (
  provider_ref TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  environment TEXT NOT NULL,
  original_transaction_id TEXT,
  purchase_token TEXT,
  product_id TEXT NOT NULL,
  account_id UUID REFERENCES account (id) ON DELETE SET NULL,
  last_word TEXT,
  last_word_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT store_purchase_platform_check CHECK (platform IN ('ios', 'android')),
  CONSTRAINT store_purchase_environment_check CHECK (environment IN ('production', 'sandbox')),
  CONSTRAINT store_purchase_ref_check CHECK (
    (platform = 'ios' AND provider_ref = 'apple:' || original_transaction_id AND purchase_token IS NULL)
    OR (platform = 'android' AND provider_ref LIKE 'google:%' AND purchase_token IS NOT NULL
        AND original_transaction_id IS NULL)
  )
);

CREATE INDEX store_purchase_account_idx ON store_purchase (account_id);
CREATE INDEX store_purchase_sync_idx ON store_purchase (platform, last_sync_at NULLS FIRST);

CREATE TABLE store_notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  notification_id TEXT NOT NULL,
  -- The store's own name of the event (`DID_RENEW`, `GRACE_PERIOD`, `4:SUBSCRIPTION_PURCHASED`…).
  notification_type TEXT NOT NULL,
  provider_ref TEXT,
  -- Google's token, until the worker has read the purchase's state; then NULL.
  purchase_token TEXT,
  event_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  -- `events:<n>`, `ignored`, `unknown`, `no_purchase`, `unavailable`.
  result TEXT,
  CONSTRAINT store_notification_platform_check CHECK (platform IN ('ios', 'android')),
  CONSTRAINT store_notification_id_key UNIQUE (platform, notification_id)
);

CREATE INDEX store_notification_waiting_idx ON store_notification (received_at)
  WHERE processed_at IS NULL;

CREATE TABLE store_api_health (
  platform TEXT PRIMARY KEY,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_failure TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT store_api_health_platform_check CHECK (platform IN ('ios', 'android'))
);

-- Down Migration
DROP TABLE store_api_health;
DROP TABLE store_notification;
DROP TABLE store_purchase;
ALTER TABLE subscription DROP COLUMN grace_reminded_until;
ALTER TABLE plan DROP CONSTRAINT plan_store_products_check;
ALTER TABLE plan DROP COLUMN store_product_ids;

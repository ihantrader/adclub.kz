-- Up Migration
-- The gateway of messages to suppliers (ARCHITECTURE.md 5.11, 9.1, 4.35;
-- TASK-024; PRODUCT 8.4, 15; SCREENS 8.5).
--
-- One path out of the platform: an approved template, a queue, a provider
-- behind a port, and the provider's answer through a webhook whose
-- signature is checked. Three tables: what we sent, what the provider sent
-- back, and the buttons people pressed (acting on a press is TASK-025).
--
-- What is kept and for how long: the template, the language, the number,
-- the delivery status and the provider's id stay as the delivery log; the
-- values of the placeholders are kept only while the message still has to
-- be sent and are cleared when it is settled — a message carries a
-- customer's name and telephone (W-02), which a log has no reason to hold.
-- The body of a webhook is likewise cleared once it has been applied.

CREATE TABLE outbound_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One event, one recipient, one message — whatever the queue does.
  dedupe_key TEXT NOT NULL,
  template TEXT NOT NULL,
  lang TEXT NOT NULL,
  phone TEXT NOT NULL,
  -- What the message is about; messaging itself knows nothing of suppliers
  -- or orders, so there is no foreign key here on purpose (as `audit_log`).
  subject_type TEXT NOT NULL,
  subject_id UUID,
  variables JSONB,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  -- The attempts the message may have (the setting when it was queued); the
  -- handler settles the message as failed on its last one.
  max_attempts INTEGER NOT NULL DEFAULT 5,
  claimed_until TIMESTAMPTZ,
  provider TEXT,
  provider_message_id TEXT,
  failure_kind TEXT,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbound_message_status_check CHECK (
    status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled', 'unknown')
  ),
  CONSTRAINT outbound_message_lang_check CHECK (lang IN ('kk', 'ru')),
  CONSTRAINT outbound_message_attempts_check CHECK (
    attempts >= 0 AND max_attempts BETWEEN 1 AND 1000
  ),
  CONSTRAINT outbound_message_phone_check CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT outbound_message_provider_check CHECK (
    provider IS NULL OR provider IN ('test', 'whatsapp_cloud')
  ),
  -- The provider's id exists exactly for the statuses that mean it took the
  -- message; a status of delivery can never be reached without one.
  CONSTRAINT outbound_message_provider_id_check CHECK (
    status NOT IN ('sent', 'delivered', 'read') OR provider_message_id IS NOT NULL
  ),
  CONSTRAINT outbound_message_sent_check CHECK (
    status NOT IN ('sent', 'delivered', 'read') OR sent_at IS NOT NULL
  ),
  CONSTRAINT outbound_message_delivered_check CHECK (
    status NOT IN ('delivered', 'read') OR delivered_at IS NOT NULL
  ),
  CONSTRAINT outbound_message_read_check CHECK (status <> 'read' OR read_at IS NOT NULL),
  -- Settled means nothing more is owed: sent (or further), failed for good,
  -- cancelled, or interrupted with an unknown outcome.
  CONSTRAINT outbound_message_settled_check CHECK (
    (status IN ('queued', 'sending')) = (settled_at IS NULL)
  ),
  -- The values of the placeholders live exactly as long as they may still
  -- be needed to send the message: they go the moment the provider took it,
  -- and when it was cancelled. A message refused for good keeps them,
  -- because retrying it is what the operator does — a sweeper clears those
  -- after `message_variables_retention_days`. The one exception is the test
  -- channel of development and tests, which sent nothing anywhere: its rows
  -- keep their values so `/dev/messages` can show what would have gone out,
  -- and production cannot run that channel (`loadConfig`).
  CONSTRAINT outbound_message_variables_check CHECK (
    variables IS NULL
    OR settled_at IS NULL
    OR provider = 'test'
    OR status IN ('failed', 'unknown')
  ),
  CONSTRAINT outbound_message_failure_check CHECK (
    status <> 'failed' OR failure_kind IS NOT NULL
  )
);

CREATE UNIQUE INDEX outbound_message_dedupe_key ON outbound_message (dedupe_key);
-- Two messages can never share the provider's id: a delivery event must
-- name exactly one message.
CREATE UNIQUE INDEX outbound_message_provider_id_key ON outbound_message (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
-- What the worker looks for, and what the operator lists.
CREATE INDEX outbound_message_pending_idx ON outbound_message (created_at)
  WHERE status IN ('queued', 'sending');
CREATE INDEX outbound_message_created_idx ON outbound_message (created_at DESC, id DESC);
CREATE INDEX outbound_message_subject_idx ON outbound_message (subject_type, subject_id);
-- What the sweeper that clears the values of settled messages looks for, every
-- minute: without it the sweep would read the whole table each time.
-- What the sweeper that recovers interrupted attempts looks for, every minute.
CREATE INDEX outbound_message_sending_idx ON outbound_message (claimed_until)
  WHERE status = 'sending';
CREATE INDEX outbound_message_stale_variables_idx ON outbound_message (settled_at)
  WHERE variables IS NOT NULL AND settled_at IS NOT NULL;

CREATE TABLE inbound_webhook_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  -- The digest of the signed body: the provider repeats a delivery byte for
  -- byte until it gets a 200, so this is what makes the receipt idempotent.
  external_id TEXT NOT NULL,
  payload JSONB,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  result TEXT,
  error TEXT,
  CONSTRAINT inbound_webhook_event_provider_check CHECK (provider IN ('whatsapp')),
  CONSTRAINT inbound_webhook_event_result_check CHECK (
    result IS NULL OR result IN ('applied', 'nothing_to_apply', 'failed')
  ),
  CONSTRAINT inbound_webhook_event_processed_check CHECK (
    (processed_at IS NULL) = (result IS NULL)
  ),
  -- The body is cleared when the event has been applied.
  CONSTRAINT inbound_webhook_event_payload_check CHECK (
    result IS NULL OR result = 'failed' OR payload IS NULL
  )
);

CREATE UNIQUE INDEX inbound_webhook_event_external_key
  ON inbound_webhook_event (provider, external_id);
CREATE INDEX inbound_webhook_event_received_idx ON inbound_webhook_event (received_at DESC, id DESC);
CREATE INDEX inbound_webhook_event_cleanup_idx ON inbound_webhook_event (processed_at)
  WHERE processed_at IS NOT NULL;

CREATE TABLE message_button_press (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES inbound_webhook_event (id) ON DELETE CASCADE,
  message_id UUID REFERENCES outbound_message (id),
  provider_message_id TEXT NOT NULL,
  context_provider_message_id TEXT,
  button_name TEXT,
  payload TEXT,
  from_phone TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  CONSTRAINT message_button_press_phone_check CHECK (from_phone ~ '^\+[1-9][0-9]{7,14}$')
);

-- The provider's id of an incoming message is unique: a repeated delivery
-- of the same press adds nothing.
CREATE UNIQUE INDEX message_button_press_provider_id_key
  ON message_button_press (provider_message_id);
CREATE INDEX message_button_press_unapplied_idx ON message_button_press (received_at)
  WHERE applied_at IS NULL;
CREATE INDEX message_button_press_message_idx ON message_button_press (message_id);

-- The invitation of an employee (W-08) is the first real user of the
-- gateway (TASK-024 requirement 5). Its own table is unchanged: it keeps
-- saying whether an invitation was asked for, went out, failed or was
-- cancelled, and its `channel` keeps the plain name of the channel
-- ('test', 'whatsapp'); the message carries the template, the language and
-- the delivery.

-- Down Migration
DROP TABLE message_button_press;
DROP TABLE inbound_webhook_event;
DROP TABLE outbound_message;

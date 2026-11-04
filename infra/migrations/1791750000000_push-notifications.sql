-- Up Migration
-- Push notifications to the user (TASK-051; PRODUCT 15; SCREENS 8.4;
-- ARCHITECTURE 5, 9.3, 4.79).
--
-- 1. `device_token` — the platform's push token of one device, bound to the
--    session that registered it: a push goes only to a token whose session is
--    alive, so the end of a session (sign-out, «Завершить на всех других», an
--    administrator, expiry) takes the device off push at once, whatever path
--    ended it. A token is one device: the same token sent by another session
--    moves to it (sign-in with another number on the same phone).
-- 2. `notification` — one notification to one person about one event (the
--    journal of ARCHITECTURE 5): `dedupe_key` makes «one event, one person, one
--    notification» true whatever the queue does; `acked_at` — the app said it
--    got it (any device); `fallback_of_id` — the WhatsApp copy of TASK-052.
-- 3. `notification_delivery` — the notification sent to one device, with its
--    own attempts, claim and outcome (the shape of `outbound_message`).

CREATE TABLE device_token (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  -- The session that registered it; a session deleted by the cleanup takes its
  -- token with it.
  session_id UUID NOT NULL REFERENCES session (id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  token TEXT NOT NULL,
  device_model TEXT,
  -- Set when the token is taken off push: its session ended, the provider said
  -- it is dead, or the app removed it.
  deactivated_at TIMESTAMPTZ,
  deactivated_reason TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_token_platform_check CHECK (platform IN ('ios', 'android')),
  CONSTRAINT device_token_token_check CHECK (length(token) BETWEEN 16 AND 4096),
  CONSTRAINT device_token_model_check CHECK (device_model IS NULL OR length(device_model) <= 100),
  CONSTRAINT device_token_deactivated_check CHECK (
    (deactivated_at IS NULL) = (deactivated_reason IS NULL)
    AND (
      deactivated_reason IS NULL
      OR deactivated_reason IN ('session_ended', 'invalid_token', 'removed')
    )
  )
);

-- One row per device: the same token registered again is the same row.
CREATE UNIQUE INDEX device_token_token_key ON device_token (token);
-- One device per session: a token the platform replaced is replaced in place.
CREATE UNIQUE INDEX device_token_session_key ON device_token (session_id);
CREATE INDEX device_token_account_idx ON device_token (account_id) WHERE deactivated_at IS NULL;
CREATE INDEX device_token_deactivated_idx ON device_token (deactivated_at)
  WHERE deactivated_at IS NOT NULL;

CREATE TABLE notification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key TEXT NOT NULL,
  recipient_account_id UUID NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  event_kind TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'push',
  template_code TEXT NOT NULL,
  lang TEXT NOT NULL,
  -- What the push opens and the values of its text — never a code, a QR, a
  -- telephone, an address or an employee's name (they are not in any text of
  -- SCREENS 8.4).
  payload JSONB NOT NULL,
  -- What it is about, so a screen can confirm all of an order's at once. No
  -- foreign key on purpose (as `outbound_message`): the module knows nothing
  -- of orders.
  subject_type TEXT NOT NULL,
  subject_id UUID,
  -- `queued` — deliveries are on their way; `sent` — at least one device got it
  -- from the provider; `no_device` — the person had no device for push;
  -- `failed`, `unknown`, `cancelled` — what became of all its deliveries.
  status TEXT NOT NULL DEFAULT 'queued',
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ,
  fallback_of_id UUID REFERENCES notification (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_kind_check CHECK (
    event_kind IN (
      'order_accepted', 'order_ready', 'order_confirmed', 'order_declined',
      'order_expired_no_response', 'term_proposed', 'time_proposed', 'reserve_expiring',
      'order_closed', 'supply_overdue', 'review_text_rejected', 'maintenance_reminder',
      'payment_failed'
    )
  ),
  CONSTRAINT notification_channel_check CHECK (channel IN ('push', 'whatsapp')),
  CONSTRAINT notification_lang_check CHECK (lang IN ('kk', 'ru', 'en')),
  CONSTRAINT notification_status_check CHECK (
    status IN ('queued', 'sent', 'no_device', 'failed', 'unknown', 'cancelled')
  ),
  CONSTRAINT notification_sent_check CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

CREATE UNIQUE INDEX notification_dedupe_key ON notification (dedupe_key);
CREATE INDEX notification_created_idx ON notification (created_at DESC, id DESC);
CREATE INDEX notification_subject_idx ON notification (subject_type, subject_id);
CREATE INDEX notification_recipient_idx ON notification (recipient_account_id, created_at DESC);
-- The share of pushes the app did not confirm (metrics) and what TASK-052 waits on.
CREATE INDEX notification_unacked_idx ON notification (sent_at)
  WHERE status = 'sent' AND acked_at IS NULL;

CREATE TABLE notification_delivery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notification (id) ON DELETE CASCADE,
  -- `NULL` once the cleanup removed the token; the mask keeps what the row was.
  device_token_id UUID REFERENCES device_token (id) ON DELETE SET NULL,
  token_mask TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  claimed_until TIMESTAMPTZ,
  provider TEXT,
  provider_message_id TEXT,
  failure_kind TEXT,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_delivery_status_check CHECK (
    status IN ('queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled')
  ),
  CONSTRAINT notification_delivery_platform_check CHECK (platform IN ('ios', 'android')),
  CONSTRAINT notification_delivery_attempts_check CHECK (
    attempts >= 0 AND max_attempts BETWEEN 1 AND 1000
  ),
  CONSTRAINT notification_delivery_provider_check CHECK (
    provider IS NULL OR provider IN ('test', 'fcm')
  ),
  CONSTRAINT notification_delivery_sent_check CHECK (
    status <> 'sent' OR (provider_message_id IS NOT NULL AND sent_at IS NOT NULL)
  ),
  CONSTRAINT notification_delivery_settled_check CHECK (
    (status IN ('queued', 'sending')) = (settled_at IS NULL)
  ),
  CONSTRAINT notification_delivery_failure_check CHECK (
    status <> 'failed' OR failure_kind IS NOT NULL
  )
);

-- One device gets one copy of one notification.
CREATE UNIQUE INDEX notification_delivery_device_key ON notification_delivery
  (notification_id, device_token_id) WHERE device_token_id IS NOT NULL;
CREATE INDEX notification_delivery_notification_idx ON notification_delivery (notification_id);
CREATE INDEX notification_delivery_sending_idx ON notification_delivery (claimed_until)
  WHERE status = 'sending';

-- Down Migration
DROP TABLE notification_delivery;
DROP TABLE notification;
DROP TABLE device_token;

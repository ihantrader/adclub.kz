-- Up Migration
-- The WhatsApp fallback of a critical push to the user (TASK-052; PRODUCT 15;
-- ARCHITECTURE 5, 9.3, 4.80).
--
-- 1. `notification` gets the decision about its fallback: a push of a critical
--    kind the app did not confirm within `push_ack_timeout_minutes` (or that
--    had nowhere to go) is copied once to WhatsApp — a row of its own,
--    `channel = 'whatsapp'`, pointing at the push by `fallback_of_id` (unique:
--    one push, at most one copy) and at the gateway's message. The push row
--    keeps why there was none (`acked`, `superseded`, `no_whatsapp`, …). A
--    WhatsApp row moves with the gateway's message: `delivered` and `read` are
--    its statuses only.
-- 2. `notification_recipient_state` — how many critical pushes in a row went
--    unconfirmed (`push_unreliable` is that count reaching the setting); any
--    confirmation resets it. «No WhatsApp» is not stored: it is the last
--    decisive word about the number in `phone_verification` and
--    `outbound_message`, read where needed.

ALTER TABLE notification
  ADD COLUMN fallback_decision TEXT,
  ADD COLUMN fallback_decided_at TIMESTAMPTZ,
  ADD COLUMN outbound_message_id UUID REFERENCES outbound_message (id) ON DELETE SET NULL;

ALTER TABLE notification DROP CONSTRAINT notification_status_check;
ALTER TABLE notification ADD CONSTRAINT notification_status_check CHECK (
  status IN ('queued', 'sent', 'no_device', 'failed', 'unknown', 'cancelled')
  OR (channel = 'whatsapp' AND status IN ('delivered', 'read'))
);
ALTER TABLE notification ADD CONSTRAINT notification_fallback_link_check CHECK (
  (channel = 'push') = (fallback_of_id IS NULL)
);
ALTER TABLE notification ADD CONSTRAINT notification_fallback_decision_check CHECK (
  fallback_decision IS NULL OR (
    channel = 'push' AND fallback_decided_at IS NOT NULL AND fallback_decision IN (
      'sent', 'not_critical', 'acked', 'superseded', 'not_current', 'stale', 'no_whatsapp',
      'rate_limited',
      'render_failed'
    )
  )
);

-- The pushes sent before this migration are no candidates: their events
-- happened before there was any fallback and may be long dealt with.
UPDATE notification SET fallback_decision = 'stale', fallback_decided_at = now()
  WHERE channel = 'push';

-- «A later push» is decided by `created_at`: the moment of the insert, not of
-- the start of its transaction (two pushes of one transaction, a long sweep).
ALTER TABLE notification ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE UNIQUE INDEX notification_fallback_of_key ON notification (fallback_of_id)
  WHERE fallback_of_id IS NOT NULL;
-- What the sweeper `notifications.fallback` looks at: pushes not decided yet.
CREATE INDEX notification_fallback_pending_idx ON notification (created_at, id)
  WHERE channel = 'push' AND fallback_decision IS NULL;
CREATE INDEX notification_outbound_message_idx ON notification (outbound_message_id)
  WHERE outbound_message_id IS NOT NULL;

-- The last decisive word about a number (delivered, or refused `no_whatsapp`):
-- «no WhatsApp» of a user is read per number.
CREATE INDEX outbound_message_phone_idx ON outbound_message (phone, updated_at DESC);

CREATE TABLE notification_recipient_state (
  account_id UUID PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  -- Critical pushes in a row whose fallback was decided by the timeout.
  unacked_streak INTEGER NOT NULL DEFAULT 0,
  -- The first of them (`push не подтверждается с {дата}`); `null` with no streak.
  unacked_since TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT notification_recipient_state_streak_check CHECK (
    unacked_streak >= 0 AND ((unacked_streak = 0) = (unacked_since IS NULL))
  )
);

CREATE INDEX notification_recipient_state_streak_idx ON notification_recipient_state
  (unacked_streak) WHERE unacked_streak > 0;

-- Down Migration
DROP TABLE notification_recipient_state;
DROP INDEX outbound_message_phone_idx;
DELETE FROM notification WHERE channel = 'whatsapp';
DROP INDEX notification_outbound_message_idx;
DROP INDEX notification_fallback_pending_idx;
DROP INDEX notification_fallback_of_key;
ALTER TABLE notification ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE notification DROP CONSTRAINT notification_fallback_decision_check;
ALTER TABLE notification DROP CONSTRAINT notification_fallback_link_check;
ALTER TABLE notification DROP CONSTRAINT notification_status_check;
ALTER TABLE notification ADD CONSTRAINT notification_status_check CHECK (
  status IN ('queued', 'sent', 'no_device', 'failed', 'unknown', 'cancelled')
);
ALTER TABLE notification
  DROP COLUMN outbound_message_id,
  DROP COLUMN fallback_decided_at,
  DROP COLUMN fallback_decision;

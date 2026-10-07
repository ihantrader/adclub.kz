-- Up Migration
-- Signals the administrator works with (TASK-034, ARCHITECTURE 4.52; SCREENS
-- A-SIG): «Взять в работу» (`acknowledged`) and «Закрыть с комментарием», each
-- with the version the administrator saw, who did it and when. A signal the
-- server closes by itself (the channel delivers again, the supplier is
-- reachable again) has no administrator and no comment.
--
-- A signal taken in work is still the current one of its subject: the same
-- fact coming up again counts up in it, so the unique index now covers every
-- signal that is not closed.

ALTER TABLE admin_signal
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN acknowledged_at TIMESTAMPTZ,
  ADD COLUMN acknowledged_by_admin_id UUID REFERENCES admin_user (id),
  ADD COLUMN closed_by_admin_id UUID REFERENCES admin_user (id),
  ADD COLUMN close_comment TEXT;

ALTER TABLE admin_signal
  ADD CONSTRAINT admin_signal_version_check CHECK (version >= 1),
  ADD CONSTRAINT admin_signal_acknowledged_check CHECK (
    (acknowledged_at IS NULL) = (acknowledged_by_admin_id IS NULL)
  ),
  -- A comment comes with an administrator's close and only with it.
  ADD CONSTRAINT admin_signal_close_comment_check CHECK (
    (closed_by_admin_id IS NULL) = (close_comment IS NULL)
    AND (closed_by_admin_id IS NULL OR status = 'closed')
    AND (close_comment IS NULL OR length(btrim(close_comment)) > 0)
  );

DROP INDEX admin_signal_open_key;
CREATE UNIQUE INDEX admin_signal_current_key ON admin_signal (kind, subject_type, subject_id)
  WHERE status <> 'closed';

-- Down Migration
-- Before the old index can come back, a subject may have one signal that is
-- not closed: a signal taken in work becomes open again (the old rules know
-- no more than that).
DROP INDEX admin_signal_current_key;
UPDATE admin_signal SET status = 'open' WHERE status = 'acknowledged';
CREATE UNIQUE INDEX admin_signal_open_key ON admin_signal (kind, subject_type, subject_id)
  WHERE status = 'open';

ALTER TABLE admin_signal
  DROP CONSTRAINT admin_signal_close_comment_check,
  DROP CONSTRAINT admin_signal_acknowledged_check,
  DROP CONSTRAINT admin_signal_version_check,
  DROP COLUMN close_comment,
  DROP COLUMN closed_by_admin_id,
  DROP COLUMN acknowledged_by_admin_id,
  DROP COLUMN acknowledged_at,
  DROP COLUMN version;

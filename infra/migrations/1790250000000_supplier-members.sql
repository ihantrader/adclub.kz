-- Up Migration
-- Employees of a supplier managed in the cabinet (ARCHITECTURE.md 8.3,
-- 4.27; TASK-017; PRODUCT 12.6; SCREENS S-TEAM-01, S-TEAM-02, A-SUP-03):
-- who receives the notifications about orders and in which language, the
-- contact person, who added and who removed an employee, the restore by
-- an administrator; invitations that are no longer to be sent; sessions
-- ended by an administrator.

ALTER TABLE supplier_member
  -- The switch «Получать уведомления»: when it was turned on (NULL — off).
  -- The earliest `max_notified_members` of the switched-on are the
  -- recipients (ARCHITECTURE 4.27 I262).
  ADD COLUMN notifications_enabled_at TIMESTAMPTZ,
  ADD COLUMN notification_language TEXT NOT NULL DEFAULT 'ru',
  -- Appointed by an administrator; one per company, active employees only.
  ADD COLUMN is_contact_person BOOLEAN NOT NULL DEFAULT false,
  -- Who added: the colleague (added_by = 'member') or the administrator.
  ADD COLUMN added_by_member_id UUID,
  ADD COLUMN added_by_admin_id UUID REFERENCES admin_user (id),
  -- Who removed (NULL — the development operator command).
  ADD COLUMN removed_by_member_id UUID,
  ADD COLUMN restored_at TIMESTAMPTZ,
  ADD COLUMN restored_by_admin_id UUID REFERENCES admin_user (id),
  ADD COLUMN restore_reason TEXT,
  ADD CONSTRAINT supplier_member_notification_language_check
    CHECK (notification_language IN ('kk', 'ru')),
  ADD CONSTRAINT supplier_member_notifications_active_check
    CHECK (notifications_enabled_at IS NULL OR status = 'active'),
  ADD CONSTRAINT supplier_member_contact_active_check
    CHECK (NOT is_contact_person OR status = 'active'),
  ADD CONSTRAINT supplier_member_restored_check
    CHECK ((restored_at IS NULL) = (restore_reason IS NULL)),
  -- The colleague who added or removed belongs to the same company.
  ADD CONSTRAINT supplier_member_added_by_member_fkey
    FOREIGN KEY (added_by_member_id, supplier_id) REFERENCES supplier_member (id, supplier_id),
  ADD CONSTRAINT supplier_member_removed_by_member_fkey
    FOREIGN KEY (removed_by_member_id, supplier_id) REFERENCES supplier_member (id, supplier_id);

CREATE UNIQUE INDEX supplier_member_contact_person_key ON supplier_member (supplier_id)
  WHERE is_contact_person;

-- Existing companies: the first employee is the contact person (as a
-- supplier created from now on), and the first five active employees
-- (the default of `max_notified_members`) receive notifications.
UPDATE supplier_member m SET is_contact_person = true
FROM (
  SELECT DISTINCT ON (supplier_id) id FROM supplier_member
  WHERE status = 'active'
  ORDER BY supplier_id, created_at, id
) first
WHERE m.id = first.id;

UPDATE supplier_member m SET notifications_enabled_at = m.created_at
FROM (
  SELECT id, row_number() OVER (PARTITION BY supplier_id ORDER BY created_at, id) AS n
  FROM supplier_member
  WHERE status = 'active'
) ranked
WHERE m.id = ranked.id AND ranked.n <= 5;

-- An invitation that must not go any more: the employee was removed
-- before it was sent.
ALTER TABLE supplier_invitation DROP CONSTRAINT supplier_invitation_status_check;
ALTER TABLE supplier_invitation ADD CONSTRAINT supplier_invitation_status_check
  CHECK (status IN ('queued', 'sent', 'failed', 'cancelled'));

-- A cabinet session ended by an administrator.
ALTER TABLE session DROP CONSTRAINT session_revoked_reason_check;
ALTER TABLE session ADD CONSTRAINT session_revoked_reason_check CHECK (
  revoked_reason IN (
    'logout', 'ended_by_owner', 'ended_others', 'ended_all', 'refresh_reuse',
    'access_closed', 'admin_removed', 'totp_reset', 'ended_by_admin'
  )
);

-- Active sessions of a company (the administrator's list).
CREATE INDEX session_supplier_active_idx ON session (supplier_id)
  WHERE revoked_at IS NULL AND supplier_id IS NOT NULL;

-- Down Migration
-- The previous lists come back NOT VALID: rows already written with a new
-- value keep it.
DROP INDEX session_supplier_active_idx;
ALTER TABLE session DROP CONSTRAINT session_revoked_reason_check;
ALTER TABLE session ADD CONSTRAINT session_revoked_reason_check CHECK (
  revoked_reason IN (
    'logout', 'ended_by_owner', 'ended_others', 'ended_all', 'refresh_reuse',
    'access_closed', 'admin_removed', 'totp_reset'
  )
) NOT VALID;
ALTER TABLE supplier_invitation DROP CONSTRAINT supplier_invitation_status_check;
ALTER TABLE supplier_invitation ADD CONSTRAINT supplier_invitation_status_check
  CHECK (status IN ('queued', 'sent', 'failed')) NOT VALID;
DROP INDEX supplier_member_contact_person_key;
ALTER TABLE supplier_member
  DROP CONSTRAINT supplier_member_removed_by_member_fkey,
  DROP CONSTRAINT supplier_member_added_by_member_fkey,
  DROP CONSTRAINT supplier_member_restored_check,
  DROP CONSTRAINT supplier_member_contact_active_check,
  DROP CONSTRAINT supplier_member_notifications_active_check,
  DROP CONSTRAINT supplier_member_notification_language_check,
  DROP COLUMN restore_reason,
  DROP COLUMN restored_by_admin_id,
  DROP COLUMN restored_at,
  DROP COLUMN removed_by_member_id,
  DROP COLUMN added_by_admin_id,
  DROP COLUMN added_by_member_id,
  DROP COLUMN is_contact_person,
  DROP COLUMN notification_language,
  DROP COLUMN notifications_enabled_at;

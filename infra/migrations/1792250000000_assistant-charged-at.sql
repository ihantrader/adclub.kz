-- Up Migration
-- When a dialog of the assistant was counted (TASK-063; ARCHITECTURE 4.85
-- I971, 4.86): an account's dialogs of the Almaty day are those charged
-- that day, not those opened that day — a dialog opened yesterday and first
-- answered today counts against today. `charged_at` is set with `charged`
-- and cleared with it when the dialog is given back; the dialogs counted
-- before this migration keep the moment they were opened.
ALTER TABLE assistant_dialog ADD COLUMN charged_at TIMESTAMPTZ;
UPDATE assistant_dialog SET charged_at = created_at WHERE charged;
ALTER TABLE assistant_dialog ADD CONSTRAINT assistant_dialog_charged_at_check
  CHECK (charged = (charged_at IS NOT NULL));

-- The day's dialogs of an account, by the moment they were counted.
CREATE INDEX assistant_dialog_account_charged_idx ON assistant_dialog (account_id, charged_at)
  WHERE account_id IS NOT NULL AND charged;

-- Down Migration
DROP INDEX assistant_dialog_account_charged_idx;
ALTER TABLE assistant_dialog DROP CONSTRAINT assistant_dialog_charged_at_check;
ALTER TABLE assistant_dialog DROP COLUMN charged_at;

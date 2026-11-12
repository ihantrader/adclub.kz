-- Up Migration
-- The client's key of a new dialog (TASK-063.B; ARCHITECTURE 4.86 I990): a
-- send whose answer was lost on the way (the network dropped while the
-- model worked) may have opened a dialog the app never learned of; sent
-- again with the same key, the message goes into that dialog instead of
-- opening — and spending — another one. Dialogs opened before this
-- migration have no key.
ALTER TABLE assistant_dialog ADD COLUMN open_key UUID;

-- One dialog per key: two sends with one key at once open at most one.
CREATE UNIQUE INDEX assistant_dialog_open_key_key ON assistant_dialog (open_key)
  WHERE open_key IS NOT NULL;

-- Down Migration
DROP INDEX assistant_dialog_open_key_key;
ALTER TABLE assistant_dialog DROP COLUMN open_key;

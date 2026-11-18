-- Up Migration
-- TASK-066 (ARCHITECTURE 8.6, 14): the setting `guest_ip_rate_limit_per_hour`
-- is gone from the registry — no route ever read it; every guest route keeps
-- its own limit by address (`vehicle_document_per_ip`, `speech_per_ip`,
-- `assistant_guest_per_ip`, `photo_requests_per_ip`, `speech_requests_per_ip`).
-- A stored value of a key the registry does not know is only ignored with a
-- warning at every read (ARCHITECTURE 4.11 I104); the value goes so that
-- warning does not stay forever. Its history (`app_setting_change`) is
-- append-only and stays as the record of what was set.
DELETE FROM app_setting WHERE key = 'guest_ip_rate_limit_per_hour';

-- Down Migration
-- The value is not restored: the key has no meaning without the registry entry.
SELECT 1;

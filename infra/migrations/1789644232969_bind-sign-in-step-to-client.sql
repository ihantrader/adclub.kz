-- Up Migration
-- An unfinished sign-in is bound to the client that passed the login code
-- (ARCHITECTURE.md 4.8; TASK-006.A): the keyed hash of a random value kept
-- in that browser's HttpOnly cookie. Steps created before this migration
-- have none and can't be finished (they live minutes; signing in again
-- creates a bound one).
ALTER TABLE sign_in_step ADD COLUMN client_binding_hash TEXT;

-- Down Migration
ALTER TABLE sign_in_step DROP COLUMN client_binding_hash;

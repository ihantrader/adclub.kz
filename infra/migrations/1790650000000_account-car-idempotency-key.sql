-- Up Migration
-- The key of one adding of a car to the account's garage (ARCHITECTURE 4.46;
-- TASK-029.B). The app makes it once per «Сохранить» and sends it with
-- `POST /garage/cars`; a request repeated after its answer was lost on the
-- way finds the car the first one added instead of adding a second one.
-- NULL — a car added without a key (a transfer, an older client).

ALTER TABLE account_car ADD COLUMN idempotency_key UUID;

-- One car per key within an account, whoever races for it: the database
-- holds this, not only the account row lock of the service.
CREATE UNIQUE INDEX account_car_idempotency_key
  ON account_car (account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Down Migration
DROP INDEX account_car_idempotency_key;
ALTER TABLE account_car DROP COLUMN idempotency_key;

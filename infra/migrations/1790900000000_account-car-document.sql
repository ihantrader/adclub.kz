-- Up Migration
-- A car added by a photographed Kazakhstan registration certificate (D-064,
-- TASK-057; ARCHITECTURE 4.58). The photo itself is stored nowhere; what the
-- garage keeps is the VIN, the plate and the mark about the document.
--
-- `vin` — 17 characters of A–Z and 0–9 without I, O, Q, upper case; the
-- check digit is not required (Chinese makes don't keep to it).
-- `plate` — compact, `123ABC02` (since 2012) or `A123BCD` (the older plate).
-- `document_status` — `shown`: a certificate was read when the car was added
-- or later («Подтвердить техпаспортом»); `unconfirmed`: the car was chosen
-- from the list after recognition did not work. NULL — a car added before
-- TASK-057, which has no mark at all. `document_at` — the moment of the mark.

ALTER TABLE account_car
  ADD COLUMN vin TEXT CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  ADD COLUMN plate TEXT CHECK (
    plate ~ '^[0-9]{3}[A-Z]{2,3}(0[1-9]|1[0-9]|20)$' OR plate ~ '^[A-Z][0-9]{3}[A-Z]{2,3}$'
  ),
  ADD COLUMN document_status TEXT CHECK (document_status IN ('shown', 'unconfirmed')),
  ADD COLUMN document_at TIMESTAMPTZ,
  ADD CONSTRAINT account_car_document_at_check
    CHECK ((document_status IS NULL) = (document_at IS NULL));

-- One VIN is one car: the same VIN twice in one garage is refused by the
-- server (`GARAGE_VIN_TAKEN`), and the database holds it too.
CREATE UNIQUE INDEX account_car_vin_key ON account_car (account_id, vin) WHERE vin IS NOT NULL;

-- Down Migration
DROP INDEX account_car_vin_key;
ALTER TABLE account_car
  DROP CONSTRAINT account_car_document_at_check,
  DROP COLUMN document_at,
  DROP COLUMN document_status,
  DROP COLUMN plate,
  DROP COLUMN vin;

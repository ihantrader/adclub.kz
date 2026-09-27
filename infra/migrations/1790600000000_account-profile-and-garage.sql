-- Up Migration
-- Account profile and the account's own garage (ARCHITECTURE 4.41; TASK-029;
-- PRODUCT 6.1, 6.3, 6.4, 6.6). `account` gains what registration needs
-- (name), the two device settings that move into it once someone is signed
-- in (city, interface language) and the one extra consent PRODUCT 6.1 asks
-- for (e-mail newsletter) — `email` and the phone-share consent
-- (`consent_phone_share_at`, `consent_version`) already exist since
-- TASK-004. `account_car` is the account's own garage, the destination of
-- the merge-without-duplicates transfer of the device's guest garage.

ALTER TABLE account
  -- Required to act as a club member (PRODUCT 6.1); NULL — registration is
  -- not finished yet (`registrationComplete`, ARCHITECTURE 4.41).
  ADD COLUMN name TEXT,
  -- The city switch (PRODUCT 6.3), once it lives in the account rather
  -- than only on the device. NULL — "весь Казахстан", same as the device.
  ADD COLUMN city_id UUID REFERENCES city (id),
  -- The interface language (PRODUCT 6.2), once it lives in the account.
  -- NULL until the first sign-in transfers the device's choice.
  ADD COLUMN language TEXT
    CONSTRAINT account_language_check CHECK (language IS NULL OR language IN ('kk', 'ru', 'en')),
  -- "Получать новости клуба на e-mail" (PRODUCT 6.1); meaningless without
  -- `email`, but kept independent so clearing the address doesn't need to
  -- also decide the flag.
  ADD COLUMN email_news_consent BOOLEAN NOT NULL DEFAULT FALSE;

-- The account's garage (ARCHITECTURE 4.41, TASK-029 requirement 2): the
-- levels and their labels are stored exactly as the device's `GarageCar`
-- holds them (mobile ARCHITECTURE 4.38 I397) rather than only ids resolved
-- by a join, so a car a second device has never seen still renders without
-- another round trip to the vehicle catalog, and so history is not rewritten
-- if the catalog's own labels change later (the same reasoning as an offer's
-- snapshot, ARCHITECTURE 4.28). Only the ids matter for "is this the same
-- car" (the merge, TASK-029 requirement 2); the labels are display only.
-- `body_type_id`/`transmission_type_id`/`drive_type_id` are left without a
-- foreign key to `vehicle_option` (unlike `item_compatibility`'s equivalent
-- columns): that table's rows are told apart only together with `kind`, and
-- adding the same `..._kind` companion columns and composite key here only to
-- guard a value the account garage never computes anything from (no
-- compatibility check reads `account_car`, PRODUCT 6.4) is not worth the
-- weight — a garage-only application check keeps them consistent instead
-- (`GarageService`).
CREATE TABLE account_car (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES account (id),
  make_id UUID NOT NULL REFERENCES vehicle_make (id),
  make_label TEXT NOT NULL,
  model_id UUID NOT NULL REFERENCES vehicle_model (id),
  model_label TEXT NOT NULL,
  year INTEGER,
  generation_id UUID REFERENCES vehicle_generation (id),
  generation_label TEXT,
  body_type_id UUID,
  body_type_label TEXT,
  engine_id UUID REFERENCES vehicle_engine (id),
  engine_label TEXT,
  transmission_type_id UUID,
  transmission_type_label TEXT,
  drive_type_id UUID,
  drive_type_label TEXT,
  -- Known only when the levels named exactly one modification (mobile
  -- ARCHITECTURE 4.38 I397); not used by the merge, only echoed back.
  modification_id UUID REFERENCES vehicle_modification (id),
  -- D-063; a fixed list in application code (`packages/domain`), not a
  -- foreign key — it never affects compatibility and needs no migration
  -- of its own to add a colour.
  color TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX account_car_account_id_idx ON account_car (account_id);
-- At most one primary car per account, enforced by the database, not only
-- by the application (the transfer and two devices can race).
CREATE UNIQUE INDEX account_car_primary_key ON account_car (account_id) WHERE is_primary;

-- Down Migration
DROP INDEX account_car_primary_key;
DROP INDEX account_car_account_id_idx;
DROP TABLE account_car;

ALTER TABLE account
  DROP COLUMN email_news_consent,
  DROP CONSTRAINT account_language_check,
  DROP COLUMN language,
  DROP COLUMN city_id,
  DROP COLUMN name;

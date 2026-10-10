-- Up Migration
-- Offers on services (TASK-019; PRODUCT 11, 7.8; SCREENS S-OFF-04, M-CAT-08;
-- ARCHITECTURE 5.5, 4.61).
--
-- An offer on a service is the same `offer` on an item of the type
-- `service`. A service is done at the point: it has no availability, no
-- term, no pickup and no delivery — the columns hold the neutral values
-- (`in_stock`, 0, false, false) and nothing else. Its price is one for all
-- models (`price_mode = 'single'`, the price in `offer.price`, as a
-- product's) or a price per model of the car (`by_model`): a row of
-- `offer_model_price` per model, and `offer.price` holds the lowest of them
-- («от N ₸») — kept so by the constraint trigger below, whoever writes.

ALTER TABLE offer DROP CONSTRAINT offer_item_type_check;
ALTER TABLE offer ADD CONSTRAINT offer_item_type_check
  CHECK (item_type IN ('part', 'generic', 'service'));

ALTER TABLE offer DROP CONSTRAINT offer_receipt_check;
ALTER TABLE offer ADD CONSTRAINT offer_receipt_check
  CHECK (item_type = 'service' OR pickup OR delivery);

ALTER TABLE offer ADD COLUMN price_mode TEXT NOT NULL DEFAULT 'single';
ALTER TABLE offer ADD CONSTRAINT offer_price_mode_check
  CHECK (price_mode IN ('single', 'by_model'));
-- Prices by model are a service's only.
ALTER TABLE offer ADD CONSTRAINT offer_price_mode_service_check
  CHECK (price_mode = 'single' OR item_type = 'service');
-- A service is done at the point: no availability, term, pickup or delivery.
ALTER TABLE offer ADD CONSTRAINT offer_service_terms_check CHECK (
  item_type <> 'service'
  OR (availability = 'in_stock' AND lead_days = 0 AND NOT pickup AND NOT delivery)
);

-- One row per model of the car; a model in the archive keeps its price
-- (a client with such a model doesn't see it — the server's rule).
CREATE TABLE offer_model_price (
  offer_id UUID NOT NULL REFERENCES offer (id),
  vehicle_model_id UUID NOT NULL REFERENCES vehicle_model (id),
  price INTEGER NOT NULL,
  CONSTRAINT offer_model_price_pkey PRIMARY KEY (offer_id, vehicle_model_id),
  CONSTRAINT offer_model_price_price_check CHECK (price > 0)
);

CREATE INDEX offer_model_price_model_idx ON offer_model_price (vehicle_model_id);

-- At the end of each transaction that touched an offer or its prices:
-- prices by model ⇔ at least one row, and then `offer.price` is the lowest
-- of them; one price for all ⇔ no rows.
CREATE FUNCTION offer_model_price_consistent() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  target UUID;
  mode TEXT;
  stored INTEGER;
  rows_count INTEGER;
  lowest INTEGER;
BEGIN
  -- One field per branch: a record has only its own table's fields.
  IF TG_TABLE_NAME = 'offer' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.offer_id;
  ELSE
    target := NEW.offer_id;
  END IF;
  SELECT price_mode, price INTO mode, stored FROM offer WHERE id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*), min(price) INTO rows_count, lowest
    FROM offer_model_price WHERE offer_id = target;
  IF mode = 'by_model' AND (rows_count = 0 OR stored <> lowest) THEN
    RAISE EXCEPTION 'offer % priced by model must have model prices and the lowest as its price', target
      USING ERRCODE = 'check_violation';
  END IF;
  IF mode = 'single' AND rows_count > 0 THEN
    RAISE EXCEPTION 'offer % with one price must have no model prices', target
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER offer_model_price_consistent_offer
  AFTER INSERT OR UPDATE OF price, price_mode ON offer
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION offer_model_price_consistent();

CREATE CONSTRAINT TRIGGER offer_model_price_consistent_rows
  AFTER INSERT OR UPDATE OR DELETE ON offer_model_price
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION offer_model_price_consistent();

-- Down Migration
-- Offers on services go with the feature: nothing can be ordered on them
-- (orders refuse services), so no order points at one.
DROP TRIGGER offer_model_price_consistent_rows ON offer_model_price;
DROP TRIGGER offer_model_price_consistent_offer ON offer;
DROP FUNCTION offer_model_price_consistent();
DROP TABLE offer_model_price;
DELETE FROM offer WHERE item_type = 'service';
ALTER TABLE offer DROP CONSTRAINT offer_service_terms_check;
ALTER TABLE offer DROP CONSTRAINT offer_price_mode_service_check;
ALTER TABLE offer DROP CONSTRAINT offer_price_mode_check;
ALTER TABLE offer DROP COLUMN price_mode;
ALTER TABLE offer DROP CONSTRAINT offer_receipt_check;
ALTER TABLE offer ADD CONSTRAINT offer_receipt_check CHECK (pickup OR delivery);
ALTER TABLE offer DROP CONSTRAINT offer_item_type_check;
ALTER TABLE offer ADD CONSTRAINT offer_item_type_check CHECK (item_type IN ('part', 'generic'));

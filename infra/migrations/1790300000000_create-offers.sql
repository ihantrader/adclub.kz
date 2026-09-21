-- Up Migration
-- Offers of suppliers on catalog goods (ARCHITECTURE.md 5.5, 4.28;
-- TASK-018; PRODUCT 7.1, 9, 9.1, 12.3, 12.4; SCREENS S-OFF-01…03).
--
-- A supplier puts its price and terms on an item of the catalog for its
-- pickup point: one offer per item and point. Offers are never deleted:
-- taken off sale, an offer waits to be returned. Whether users see it is
-- decided by the server (4.28), not stored: a supplier's pause or block,
-- an archived item or a hidden category hide an offer without changing it.
-- Offers on services — TASK-019 (the type check will widen then).

-- An offer names its point together with the supplier: a point of another
-- supplier can't be used.
ALTER TABLE supplier_location
  ADD CONSTRAINT supplier_location_id_supplier_key UNIQUE (id, supplier_id);

CREATE TABLE offer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  location_id UUID NOT NULL,
  item_id UUID NOT NULL,
  item_type TEXT NOT NULL,
  -- Whole tenge; the working bounds are the settings offer_price_min_kzt
  -- and offer_price_max_kzt, checked by the server.
  price INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KZT',
  availability TEXT NOT NULL,
  -- Working days of the point from the confirmation of an order.
  lead_days SMALLINT NOT NULL DEFAULT 0,
  pickup BOOLEAN NOT NULL,
  delivery BOOLEAN NOT NULL,
  warranty_months SMALLINT,
  warranty_text TEXT,
  -- The supplier's own article and name of the item (its price list).
  supplier_sku TEXT,
  supplier_raw_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  withdrawn_at TIMESTAMPTZ,
  withdrawn_reason TEXT,
  -- The price import that last saw the offer (EPIC-16).
  last_import_id UUID,
  last_seen_in_import_at TIMESTAMPTZ,
  created_by_member_id UUID,
  updated_by_member_id UUID,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT offer_location_fkey FOREIGN KEY (location_id, supplier_id)
    REFERENCES supplier_location (id, supplier_id),
  CONSTRAINT offer_item_fkey FOREIGN KEY (item_id, item_type)
    REFERENCES catalog_item (id, item_type),
  CONSTRAINT offer_created_by_fkey FOREIGN KEY (created_by_member_id, supplier_id)
    REFERENCES supplier_member (id, supplier_id),
  CONSTRAINT offer_updated_by_fkey FOREIGN KEY (updated_by_member_id, supplier_id)
    REFERENCES supplier_member (id, supplier_id),
  -- One item — one offer of a point, whatever its status.
  CONSTRAINT offer_location_item_key UNIQUE (supplier_id, location_id, item_id),
  CONSTRAINT offer_item_type_check CHECK (item_type IN ('part', 'generic')),
  CONSTRAINT offer_price_check CHECK (price > 0),
  CONSTRAINT offer_currency_check CHECK (currency = 'KZT'),
  CONSTRAINT offer_availability_check CHECK (availability IN ('in_stock', 'on_order')),
  CONSTRAINT offer_lead_days_check CHECK (lead_days BETWEEN 0 AND 365),
  -- Under order means a term of at least one day.
  CONSTRAINT offer_on_order_lead_check CHECK (availability <> 'on_order' OR lead_days > 0),
  CONSTRAINT offer_receipt_check CHECK (pickup OR delivery),
  CONSTRAINT offer_warranty_check CHECK (
    (warranty_months IS NULL OR warranty_months BETWEEN 1 AND 120)
    AND NOT (warranty_months IS NOT NULL AND warranty_text IS NOT NULL)
  ),
  CONSTRAINT offer_status_check CHECK (status IN ('active', 'withdrawn', 'suspended')),
  CONSTRAINT offer_withdrawn_reason_check
    CHECK (withdrawn_reason IS NULL OR withdrawn_reason IN ('manual', 'missing_in_import')),
  -- A withdrawn offer says when and why; nothing else does.
  CONSTRAINT offer_withdrawn_check CHECK (
    (status = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdrawn_reason IS NOT NULL)
    AND (withdrawn_at IS NULL) = (withdrawn_reason IS NULL)
  )
);

-- The cabinet's list: a company's offers by tab, newest first.
CREATE INDEX offer_supplier_status_created_idx ON offer (supplier_id, status, created_at DESC, id DESC);
-- The catalog (TASK-020): the offers on an item.
CREATE INDEX offer_item_idx ON offer (item_id) WHERE status = 'active';

-- Down Migration
DROP TABLE offer;
ALTER TABLE supplier_location DROP CONSTRAINT supplier_location_id_supplier_key;

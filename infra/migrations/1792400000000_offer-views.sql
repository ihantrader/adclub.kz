-- Up Migration
-- Views of offers (TASK-070; PRODUCT 12.5, 13, 16; ARCHITECTURE 5.8, 4.88).
-- The server counts a view itself when it shows an offer (the card of an item,
-- M-CAT-09 from an offer); one view — one offer, one viewer, one day of Almaty.

-- The raw views, only to keep a second look of the same viewer on the same day
-- from counting again: the key is an HMAC of the viewer (account or address)
-- with the day, so nothing here names a person or links two days of one.
-- Older than `offer_view_retention_days` — deleted by `offers.views-signal`.
CREATE TABLE offer_view_event (
  offer_id UUID NOT NULL REFERENCES offer (id) ON DELETE CASCADE,
  day DATE NOT NULL,
  viewer_key TEXT NOT NULL CHECK (length(viewer_key) BETWEEN 16 AND 64),
  viewer_kind TEXT NOT NULL CHECK (viewer_kind IN ('guest', 'user', 'club')),
  supplier_id UUID NOT NULL REFERENCES supplier (id) ON DELETE CASCADE,
  CONSTRAINT offer_view_event_pkey PRIMARY KEY (offer_id, day, viewer_key)
);

CREATE INDEX offer_view_event_day_idx ON offer_view_event (day);

-- The daily totals of an offer by kind of viewer: what the admin panel, the
-- signal and the supplier's statistics (TASK-071) read. They stay.
CREATE TABLE offer_view_daily (
  offer_id UUID NOT NULL REFERENCES offer (id) ON DELETE CASCADE,
  day DATE NOT NULL,
  viewer_kind TEXT NOT NULL CHECK (viewer_kind IN ('guest', 'user', 'club')),
  supplier_id UUID NOT NULL REFERENCES supplier (id) ON DELETE CASCADE,
  views INTEGER NOT NULL CHECK (views > 0),
  CONSTRAINT offer_view_daily_pkey PRIMARY KEY (offer_id, day, viewer_kind)
);

CREATE INDEX offer_view_daily_supplier_day_idx ON offer_view_daily (supplier_id, day);

-- Down Migration
DROP TABLE offer_view_daily;
DROP TABLE offer_view_event;

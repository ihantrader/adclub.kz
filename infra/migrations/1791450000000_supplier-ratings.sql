-- Up Migration
-- The rating of a supplier (TASK-050; PRODUCT 13; ARCHITECTURE 5.9, 13.2, 4.71;
-- SCREENS M-CAT-07, M-CAT-09, A-SUP-02, A-SUP-03).
--
-- One snapshot per supplier: the rating (`score`, 1–5 to one decimal; NULL —
-- «Новый поставщик»), the numbers behind it — the published scores in the
-- window, the orders answered of those that wanted an answer, the orders kept
-- of those that reached a verdict — the shares (NULL — «Мало заявок для
-- оценки»), the version of the formula and the rules it was counted by (the
-- weights and thresholds are settings, kept here as data). The worker writes it
-- after an event and at the nightly reconciliation, by one function
-- (`supplierRating` of `@adclub/domain`).
--
-- The history keeps what the snapshot was before each change that shows: the
-- previous and the new rating, why (`event` or `reconcile`) and when.

CREATE TABLE supplier_rating (
  supplier_id UUID PRIMARY KEY REFERENCES supplier (id),
  score NUMERIC(2, 1),
  is_new BOOLEAN NOT NULL,
  reviews_count INTEGER NOT NULL,
  reviews_average NUMERIC(3, 2),
  answered_count INTEGER NOT NULL,
  answer_required_count INTEGER NOT NULL,
  kept_count INTEGER NOT NULL,
  judged_count INTEGER NOT NULL,
  response_rate NUMERIC(5, 4),
  on_time_rate NUMERIC(5, 4),
  formula_version INTEGER NOT NULL,
  -- {weights, minReviews, minOrders, windowDays}: what the rating was counted by.
  rules JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT supplier_rating_score_check CHECK (score IS NULL OR score BETWEEN 1 AND 5),
  CONSTRAINT supplier_rating_new_check CHECK (is_new = (score IS NULL)),
  CONSTRAINT supplier_rating_counts_check CHECK (
    reviews_count >= 0 AND answered_count >= 0 AND answered_count <= answer_required_count
    AND kept_count >= 0 AND kept_count <= judged_count
  ),
  CONSTRAINT supplier_rating_average_check CHECK (
    (reviews_average IS NULL) = (reviews_count = 0)
    AND (reviews_average IS NULL OR reviews_average BETWEEN 1 AND 5)
  ),
  CONSTRAINT supplier_rating_rates_check CHECK (
    (response_rate IS NULL OR response_rate BETWEEN 0 AND 1)
    AND (on_time_rate IS NULL OR on_time_rate BETWEEN 0 AND 1)
  )
);

-- The list of A-SUP-02 by rating and «новые».
CREATE INDEX supplier_rating_score_idx ON supplier_rating (score);

CREATE TABLE supplier_rating_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  cause TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  -- The snapshot before the change and after it (the same fields as `supplier_rating`).
  before JSONB NOT NULL,
  after JSONB NOT NULL,
  CONSTRAINT supplier_rating_history_cause_check CHECK (cause IN ('event', 'reconcile'))
);

CREATE INDEX supplier_rating_history_supplier_idx
  ON supplier_rating_history (supplier_id, changed_at DESC);

-- Down Migration
DROP TABLE supplier_rating_history;
DROP TABLE supplier_rating;

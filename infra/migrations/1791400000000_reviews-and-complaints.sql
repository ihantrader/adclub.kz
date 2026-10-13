-- Up Migration
-- Reviews and complaints about orders (TASK-049; PRODUCT 13; D-042;
-- ARCHITECTURE 5.9, 4.69; SCREENS M-ORD-05, M-ORD-06, A-REV-01, A-REV-02).
--
-- A review: one per order, by the order's user, a score of 1–5 and a text if
-- any. A text waits for its check (`checking`, since `checking_since`), is
-- published or held for an administrator (`held`, with the reasons of the
-- check); the administrator publishes it or refuses the text with a reason
-- from the list (`text_rejected` — the author may correct it once, `edited`,
-- or publish the score alone); a published review may be hidden with a
-- reason and restored. The author is a reference to the account — the name
-- is read when a page is read, so a removed account (TASK-072) is made
-- anonymous in one place.
--
-- A complaint: about an order, with a reason of M-ORD-06 (a text required for
-- «Другое»), `new` → `in_progress` → `resolved` with the administrator's
-- internal comment; one open complaint per order.
--
-- AI checks a review by an operation of its own (`review_check`).

ALTER TABLE ai_job DROP CONSTRAINT ai_job_kind_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_kind_check CHECK (
  kind IN (
    'price_columns', 'price_match', 'translate', 'compat_check', 'passport_ocr',
    'dashboard_ocr', 'part_photo', 'assistant_turn', 'photo_search', 'attr_fill',
    'review_check'
  )
);

CREATE TABLE review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES customer_order (id),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  user_account_id UUID NOT NULL REFERENCES account (id),
  score SMALLINT NOT NULL,
  text TEXT,
  status TEXT NOT NULL,
  -- [{kind, source, explanation}] of the latest check; empty — none.
  hold_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  edited BOOLEAN NOT NULL DEFAULT false,
  checking_since TIMESTAMPTZ,
  rejected_reason TEXT,
  rejected_at TIMESTAMPTZ,
  rejected_by_admin_id UUID REFERENCES admin_user (id),
  hidden_reason TEXT,
  hidden_at TIMESTAMPTZ,
  hidden_by_admin_id UUID REFERENCES admin_user (id),
  published_at TIMESTAMPTZ,
  idempotency_key UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT review_order_key UNIQUE (order_id),
  CONSTRAINT review_score_check CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT review_status_check CHECK (
    status IN ('checking', 'published', 'held', 'text_rejected', 'hidden')
  ),
  CONSTRAINT review_text_check CHECK (text IS NULL OR length(btrim(text)) > 0),
  -- Only a text is checked, refused or corrected.
  CONSTRAINT review_text_status_check CHECK (
    text IS NOT NULL OR status IN ('published', 'hidden')
  ),
  CONSTRAINT review_checking_check CHECK ((status = 'checking') = (checking_since IS NOT NULL)),
  CONSTRAINT review_rejected_check CHECK (
    (rejected_reason IS NULL) = (rejected_at IS NULL)
    AND (rejected_reason IS NULL) = (rejected_by_admin_id IS NULL)
    AND (status <> 'text_rejected' OR rejected_reason IS NOT NULL)
    AND (rejected_reason IS NULL
      OR rejected_reason IN ('profanity', 'personal_data', 'supplier_name', 'advertising'))
  ),
  CONSTRAINT review_hidden_check CHECK (
    (status = 'hidden') = (hidden_at IS NOT NULL)
    AND (hidden_at IS NULL) = (hidden_reason IS NULL)
    AND (hidden_at IS NULL) = (hidden_by_admin_id IS NULL)
  ),
  CONSTRAINT review_published_check CHECK (
    status NOT IN ('published', 'hidden') OR published_at IS NOT NULL
  ),
  CONSTRAINT review_version_check CHECK (version >= 1)
);

-- The queue «На проверке» and the sweeper of the waiting ones.
CREATE INDEX review_status_idx ON review (status, created_at);
-- The page of a supplier and its tab in the admin panel.
CREATE INDEX review_supplier_idx ON review (supplier_id, status, published_at DESC);
CREATE INDEX review_account_idx ON review (user_account_id);

CREATE TABLE complaint (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES customer_order (id),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  user_account_id UUID NOT NULL REFERENCES account (id),
  reason TEXT NOT NULL,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  comment TEXT,
  taken_at TIMESTAMPTZ,
  taken_by_admin_id UUID REFERENCES admin_user (id),
  resolved_at TIMESTAMPTZ,
  resolved_by_admin_id UUID REFERENCES admin_user (id),
  idempotency_key UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT complaint_reason_check CHECK (
    reason IN ('not_received', 'not_as_described', 'price_higher', 'no_contact', 'other')
  ),
  CONSTRAINT complaint_text_check CHECK (
    (text IS NULL OR length(btrim(text)) > 0) AND (reason <> 'other' OR text IS NOT NULL)
  ),
  CONSTRAINT complaint_status_check CHECK (status IN ('new', 'in_progress', 'resolved')),
  CONSTRAINT complaint_taken_check CHECK (
    (taken_at IS NULL) = (taken_by_admin_id IS NULL) AND (status <> 'in_progress' OR taken_at IS NOT NULL)
  ),
  CONSTRAINT complaint_resolved_check CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL)
    AND (resolved_at IS NULL) = (resolved_by_admin_id IS NULL)
    AND (status <> 'resolved' OR (comment IS NOT NULL AND length(btrim(comment)) > 0))
  ),
  CONSTRAINT complaint_version_check CHECK (version >= 1)
);

-- One open complaint per order; after «решена» — a new one.
CREATE UNIQUE INDEX complaint_open_order_key ON complaint (order_id) WHERE status <> 'resolved';
-- The same request again is the same complaint.
CREATE UNIQUE INDEX complaint_idempotency_key ON complaint (user_account_id, idempotency_key);
CREATE INDEX complaint_status_idx ON complaint (status, created_at DESC);
CREATE INDEX complaint_order_idx ON complaint (order_id);
CREATE INDEX complaint_supplier_idx ON complaint (supplier_id);

-- Down Migration
DROP TABLE complaint;
DROP TABLE review;
DELETE FROM ai_job WHERE kind = 'review_check';
ALTER TABLE ai_job DROP CONSTRAINT ai_job_kind_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_kind_check CHECK (
  kind IN (
    'price_columns', 'price_match', 'translate', 'compat_check', 'passport_ocr',
    'dashboard_ocr', 'part_photo', 'assistant_turn', 'photo_search', 'attr_fill'
  )
);

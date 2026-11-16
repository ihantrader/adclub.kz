-- Up Migration
-- The daily digest of moderation to a company, W-06 (TASK-071; PRODUCT 12.2;
-- SCREENS 7.3, 8.5; ARCHITECTURE 4.89).
--
-- The boundary of a digest is kept on each decision, not as a moment: a
-- decision the digest took is marked `digested_at` in the transaction that
-- queues the message. A decision committed while the job runs is simply not
-- marked and goes into the next digest — a moment taken by the job could
-- skip a decision committed a little later with an earlier `decided_at`.
ALTER TABLE catalog_request ADD COLUMN digested_at TIMESTAMPTZ;
ALTER TABLE item_compatibility_proposal ADD COLUMN digested_at TIMESTAMPTZ;

-- The first digest after the release takes the decisions of the last day:
-- the older ones are marked as taken (with the moment of their decision).
UPDATE catalog_request SET digested_at = decided_at
WHERE status <> 'new' AND decided_at IS NOT NULL AND decided_at < now() - interval '24 hours';
UPDATE item_compatibility_proposal SET digested_at = reviewed_at
WHERE status <> 'pending' AND reviewed_at IS NOT NULL AND reviewed_at < now() - interval '24 hours';

-- What the job looks for: the decisions of suppliers not in a digest yet.
CREATE INDEX catalog_request_undigested_idx ON catalog_request (supplier_id)
  WHERE status <> 'new' AND digested_at IS NULL;
CREATE INDEX item_compatibility_proposal_undigested_idx ON item_compatibility_proposal (supplier_id)
  WHERE status <> 'pending' AND digested_at IS NULL AND supplier_id IS NOT NULL;

-- One digest per company and day of Almaty: «не чаще раза в день». The
-- numbers are what it said; the messages are `outbound_message` rows.
CREATE TABLE supplier_moderation_digest (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id) ON DELETE CASCADE,
  day DATE NOT NULL,
  added INTEGER NOT NULL CHECK (added >= 0),
  rejected INTEGER NOT NULL CHECK (rejected >= 0),
  recipients INTEGER NOT NULL CHECK (recipients >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_moderation_digest_day_key UNIQUE (supplier_id, day),
  CONSTRAINT supplier_moderation_digest_something CHECK (added + rejected > 0)
);

-- Down Migration
DROP TABLE supplier_moderation_digest;
DROP INDEX item_compatibility_proposal_undigested_idx;
DROP INDEX catalog_request_undigested_idx;
ALTER TABLE item_compatibility_proposal DROP COLUMN digested_at;
ALTER TABLE catalog_request DROP COLUMN digested_at;

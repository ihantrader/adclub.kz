-- Up Migration
-- «Доставка по умолчанию для новых предложений» on the company card
-- (SCREENS S-COMP-01; TASK-032, ARCHITECTURE 4.48). Only the starting value
-- of the «Доставка» box in the form of a new offer: existing offers keep
-- what they have. Existing companies start without it — the form then
-- starts as it did before (pickup only).

ALTER TABLE supplier ADD COLUMN delivery_by_default BOOLEAN NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE supplier DROP COLUMN delivery_by_default;

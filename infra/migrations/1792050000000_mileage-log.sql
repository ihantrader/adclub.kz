-- Up Migration
-- The mileage journal of a car (TASK-058; ARCHITECTURE 5.8, 4.83; SCREENS
-- M-GAR-05…07). One row per reading a person confirmed: typed, or read off
-- a photo of the dashboard and checked. What the recognition read is kept
-- next to it (`recognized_km`, the AI call `ai_job_id`) and never stands in
-- for it — the result of AI and the person's word stay apart (SCREENS 9.3);
-- the photo itself is stored nowhere (D-064).
--
-- The current mileage of a car is its latest row by `recorded_at` — two
-- devices writing at once are two rows, and the later one counts. The
-- journal goes with the car (and the car with the account): no reading
-- outlives what it was about.
CREATE TABLE mileage_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id UUID NOT NULL REFERENCES account_car (id) ON DELETE CASCADE,
  value_km INTEGER NOT NULL,
  source TEXT NOT NULL,
  recognized_km INTEGER,
  ai_job_id UUID REFERENCES ai_job (id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  recorded_by UUID NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mileage_log_value_check CHECK (value_km BETWEEN 0 AND 2000000),
  CONSTRAINT mileage_log_recognized_check CHECK (
    recognized_km IS NULL OR recognized_km BETWEEN 0 AND 2000000
  ),
  -- `voice` and `prompt` are TASK-060 and TASK-069; nothing writes them yet.
  CONSTRAINT mileage_log_source_check CHECK (source IN ('text', 'photo', 'voice', 'prompt')),
  -- A reading typed has nothing recognised.
  CONSTRAINT mileage_log_text_check CHECK (
    source <> 'text' OR (recognized_km IS NULL AND ai_job_id IS NULL)
  )
);

-- The current reading of a car, and «the same reading again» of a transfer
-- repeated (one guest reading becomes one row however often it is sent).
CREATE UNIQUE INDEX mileage_log_car_reading_key ON mileage_log (car_id, recorded_at, value_km);
CREATE INDEX mileage_log_recorded_by_idx ON mileage_log (recorded_by);
CREATE INDEX mileage_log_ai_job_idx ON mileage_log (ai_job_id) WHERE ai_job_id IS NOT NULL;

-- Down Migration
DROP TABLE mileage_log;

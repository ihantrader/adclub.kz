-- Up Migration
-- What the operations scripts of a deployed environment did (TASK-055;
-- ARCHITECTURE 4.82, 15.4): the daily database dump, the daily copy of the
-- files bucket and the weekly restore check write one row each run, from the
-- `ops` container with `psql`. The API reads the last ones for its metrics
-- (`adclub_ops_last_success_timestamp_seconds`, `adclub_ops_last_run_ok`).
-- `details` holds counts, sizes and object names only — no personal data.

CREATE TABLE ops_run (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('db_backup', 'files_backup', 'restore_check')),
  ok boolean NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX ops_run_kind_finished_idx ON ops_run (kind, finished_at DESC);

-- Down Migration
DROP TABLE ops_run;

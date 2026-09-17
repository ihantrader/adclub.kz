-- Up Migration
-- Runs of periodic background jobs (ARCHITECTURE 13.1, 4.12; TASK-008): one
-- row per periodic job, written by the worker around every run. The
-- operator command shows it (last successful run); the queue itself
-- (schema pgboss) keeps completed jobs only for a while.
CREATE TABLE periodic_job_state (
  name TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ,
  last_succeeded_at TIMESTAMPTZ,
  last_failed_at TIMESTAMPTZ,
  -- Error class and message of the last failure; never the job's data.
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT periodic_job_state_last_error_check CHECK (char_length(last_error) <= 500)
);

-- Down Migration
DROP TABLE periodic_job_state;

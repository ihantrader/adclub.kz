-- Up Migration
-- AI through OpenRouter (ARCHITECTURE.md 9.6, 4.20; TASK-053, D-055/056/057):
-- the only provider is OpenRouter, a call records whether the fallback model
-- of the operation answered and whether its cost is the provider's figure or
-- this deployment's own, and a translation task remembers the administrator
-- who asked for it, so the call made for them is not recorded as the system's.

-- The provider: `claude` (the direct Anthropic channel of TASK-012) no longer
-- exists. No deployment ever ran it — there was no key (TASK-012-REPORT), so
-- there is nothing to migrate; a row with it would fail this constraint
-- loudly instead of being quietly relabelled.
ALTER TABLE ai_job DROP CONSTRAINT ai_job_provider_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_provider_check
  CHECK (provider IN ('test', 'openrouter'));

-- Two more ways a call can fail, both about the model rather than the request:
-- `model_unavailable` — OpenRouter has no endpoint for the model of the
-- setting; `no_private_provider` — it has none that keeps the request
-- unstored and untrained-on (D-057), so nothing was sent at all.
ALTER TABLE ai_job DROP CONSTRAINT ai_job_error_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_error_check CHECK (
  (status = 'failed') = (error_kind IS NOT NULL)
  AND (error_kind IS NULL OR error_kind IN
    ('unavailable', 'model_unavailable', 'no_private_provider',
     'rejected', 'invalid_output', 'not_configured'))
);

-- `cost_usd` of a running call is the hold it took against the daily budget,
-- and of a finished one the provider's figure — unless the provider did not
-- give one, and then the hold stays as the cost. `cost_is_estimate` says
-- which of the two it is, so an unknown cost is never read as nothing.
ALTER TABLE ai_job
  ADD COLUMN cost_is_estimate BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_fallback BOOLEAN NOT NULL DEFAULT false;

-- Who asked for this translation: an administrator (`account.id`) or nobody
-- in particular — a change of the Russian text, the operator command, the
-- safety net. The call made for it records the same initiator.
ALTER TABLE translation_task
  ADD COLUMN requested_by UUID REFERENCES account (id) ON DELETE SET NULL;

-- Down Migration
-- Going back removes what this migration added. It does not rewrite calls
-- that already happened: rows recorded through OpenRouter keep their
-- provider and their error kind, so the restored constraints still accept
-- those values while the older code writes only the older ones.
ALTER TABLE translation_task DROP COLUMN requested_by;
ALTER TABLE ai_job
  DROP COLUMN is_fallback,
  DROP COLUMN cost_is_estimate;
ALTER TABLE ai_job DROP CONSTRAINT ai_job_error_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_error_check CHECK (
  (status = 'failed') = (error_kind IS NOT NULL)
  AND (error_kind IS NULL OR error_kind IN
    ('unavailable', 'model_unavailable', 'no_private_provider',
     'rejected', 'invalid_output', 'not_configured'))
);
ALTER TABLE ai_job DROP CONSTRAINT ai_job_provider_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_provider_check
  CHECK (provider IN ('test', 'claude', 'openrouter'));

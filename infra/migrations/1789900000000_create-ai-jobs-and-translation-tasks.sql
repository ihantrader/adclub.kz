-- Up Migration
-- The AI call log and automatic translation of the catalog (ARCHITECTURE.md
-- 5.4, 9.6, 4.19; TASK-012): `ai_job` records every call to the AI provider;
-- `translation_task` is the queue of translations still to be made;
-- `translation` learns which model and which call made a text.

-- One row per call to the AI provider (any kind, ARCHITECTURE 5.12): what
-- was asked, of which model, for whom, how it ended and what it cost.
-- `input_ref` says what the call was about WITHOUT the content (counts,
-- kinds, ids) and `output` holds a result only for kinds whose result is a
-- proposal stored here (price matching, ...); translations live in
-- `translation` and point back with `ai_job_id`. No personal data, and an
-- `error` is a short sanitized text. The daily spend (`ai_daily_budget_usd`)
-- is the sum of `cost_usd` of the day.
CREATE TABLE ai_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  initiator_type TEXT NOT NULL,
  initiator_id UUID,
  input_ref JSONB NOT NULL DEFAULT '{}',
  output JSONB,
  status TEXT NOT NULL,
  error_kind TEXT,
  error TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd NUMERIC(12, 6),
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT ai_job_kind_check CHECK (
    kind IN (
      'price_columns', 'price_match', 'translate', 'compat_check', 'passport_ocr',
      'dashboard_ocr', 'part_photo', 'assistant_turn', 'photo_search', 'attr_fill'
    )
  ),
  CONSTRAINT ai_job_provider_check CHECK (provider IN ('test', 'claude')),
  CONSTRAINT ai_job_initiator_check CHECK (
    initiator_type IN ('system', 'account', 'guest_device')
    AND ((initiator_type = 'system') = (initiator_id IS NULL))
  ),
  CONSTRAINT ai_job_status_check CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT ai_job_error_check CHECK (
    (status = 'failed') = (error_kind IS NOT NULL)
    AND (error_kind IS NULL OR error_kind IN
      ('unavailable', 'rejected', 'invalid_output', 'not_configured'))
  ),
  CONSTRAINT ai_job_finished_check CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT ai_job_usage_check CHECK (
    (tokens_in IS NULL OR tokens_in >= 0)
    AND (tokens_out IS NULL OR tokens_out >= 0)
    AND (cost_usd IS NULL OR cost_usd >= 0)
    AND (latency_ms IS NULL OR latency_ms >= 0)
  )
);

-- The day's spend and the operator's view of recent calls.
CREATE INDEX ai_job_created_idx ON ai_job (created_at);

-- Which model and which call made an automatic translation; an automatic
-- text whose manual edit was released keeps neither (the text is a person's
-- until the automatic one replaces it).
ALTER TABLE translation
  ADD COLUMN ai_model TEXT,
  ADD COLUMN ai_job_id UUID REFERENCES ai_job (id) ON DELETE SET NULL,
  ADD CONSTRAINT translation_ai_check CHECK (
    origin = 'ai' OR (ai_model IS NULL AND ai_job_id IS NULL)
  ),
  ADD CONSTRAINT translation_ai_manual_check CHECK (origin <> 'ai' OR NOT is_manually_edited);

-- Translations still to be made: one row per entity, field and target
-- language, so two quick changes of the source leave one task (the last).
-- `source_hash` is the hash of the Russian text the task was made for; a
-- run reads the CURRENT Russian text and saves only if it still hashes to
-- the same value. `pending` — waits for a run (`claimed_until` — a run has
-- it, until then); `failed` — refused for good (`failure` says why): not
-- taken again until the source changes or an administrator asks again.
-- `attempts`/`last_error` — runs that failed for a temporary reason (the
-- provider was unavailable).
CREATE TABLE translation_task (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  field TEXT NOT NULL,
  lang TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  failure TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  claimed_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT translation_task_key UNIQUE (entity_type, entity_id, field, lang),
  CONSTRAINT translation_task_entity_type_check CHECK (
    entity_type IN ('category', 'attribute', 'attribute_option', 'catalog_item')
  ),
  CONSTRAINT translation_task_field_check CHECK (field IN ('name', 'unit')),
  CONSTRAINT translation_task_lang_check CHECK (lang IN ('kk', 'en')),
  CONSTRAINT translation_task_status_check CHECK (status IN ('pending', 'failed')),
  CONSTRAINT translation_task_failure_check CHECK (
    (status = 'failed') = (failure IS NOT NULL)
    AND (failure IS NULL OR failure IN
      ('empty', 'too_long', 'control_characters', 'wrong_language', 'name_taken'))
  ),
  CONSTRAINT translation_task_attempts_check CHECK (attempts >= 0)
);

-- What a run takes: the oldest pending tasks that no run has.
CREATE INDEX translation_task_pending_idx ON translation_task (created_at)
  WHERE status = 'pending';

-- Down Migration
DROP TABLE translation_task;
ALTER TABLE translation
  DROP CONSTRAINT translation_ai_manual_check,
  DROP CONSTRAINT translation_ai_check,
  DROP COLUMN ai_job_id,
  DROP COLUMN ai_model;
DROP TABLE ai_job;

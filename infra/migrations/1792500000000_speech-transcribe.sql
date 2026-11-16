-- Up Migration
-- Voice input (TASK-059; ARCHITECTURE 4.90): a new kind of AI call,
-- `speech_transcribe`. Its `ai_job` row holds the size and the length of the
-- recording only (`input_ref`) — never the sound, never the text.
ALTER TABLE ai_job DROP CONSTRAINT ai_job_kind_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_kind_check CHECK (
  kind IN (
    'price_columns', 'price_match', 'translate', 'compat_check', 'passport_ocr',
    'dashboard_ocr', 'part_photo', 'assistant_turn', 'photo_search', 'attr_fill',
    'review_check', 'maintenance_plan_draft', 'speech_transcribe'
  )
);

-- Down Migration
DELETE FROM ai_job WHERE kind = 'speech_transcribe';
ALTER TABLE ai_job DROP CONSTRAINT ai_job_kind_check;
ALTER TABLE ai_job ADD CONSTRAINT ai_job_kind_check CHECK (
  kind IN (
    'price_columns', 'price_match', 'translate', 'compat_check', 'passport_ocr',
    'dashboard_ocr', 'part_photo', 'assistant_turn', 'photo_search', 'attr_fill',
    'review_check', 'maintenance_plan_draft'
  )
);

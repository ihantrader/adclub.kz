-- Up Migration
-- The AI Pilot assistant (TASK-062; PRODUCT 8.3; ARCHITECTURE 11, 4.85;
-- SCREENS M-AI-01, M-AI-02).
--
-- A dialog belongs to exactly one of: an account (a signed-in person) or a
-- device (a guest, by the id the app made). It keeps the car it is about —
-- the levels as the catalog takes them and the words the model was told —
-- and the city; nothing personal (the name, the phone, the VIN and the plate
-- are never stored here, and never sent to a model).
--
-- `charged` — the dialog was counted against the person's dialogs (a
-- guest's trial ones, an account's of the Almaty day); it is counted with
-- its first turn that reaches the model, and given back when the provider
-- could not serve it. `turn_started_at` — a turn is running (two messages
-- of one dialog at once: the second one is refused, the dialog stays whole).
--
-- The account's dialogs go with the account (`ON DELETE CASCADE`, TASK-072
-- deletes accounts); the messages and complaints go with their dialog.
CREATE TABLE assistant_dialog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES account (id) ON DELETE CASCADE,
  device_id UUID,
  language TEXT NOT NULL,
  vehicle JSONB NOT NULL,
  car_words JSONB NOT NULL,
  car_id UUID REFERENCES account_car (id) ON DELETE SET NULL,
  city_id UUID REFERENCES city (id),
  turns INTEGER NOT NULL DEFAULT 0,
  charged BOOLEAN NOT NULL DEFAULT false,
  turn_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  CONSTRAINT assistant_dialog_owner_check CHECK (num_nonnulls(account_id, device_id) = 1),
  CONSTRAINT assistant_dialog_language_check CHECK (language IN ('kk', 'ru', 'en')),
  CONSTRAINT assistant_dialog_turns_check CHECK (turns >= 0)
);

-- The day's dialogs of an account and the trial ones of a device.
CREATE INDEX assistant_dialog_account_idx ON assistant_dialog (account_id, created_at)
  WHERE account_id IS NOT NULL;
CREATE INDEX assistant_dialog_device_idx ON assistant_dialog (device_id, created_at)
  WHERE device_id IS NOT NULL;

-- A message of a dialog: what the person said, or the answer of the server
-- as it was shown — its text (`text`), the kind and the intent, the items of
-- its cards (`item_ids`) and the rest of what was shown (`reply`: the
-- question's quick replies, the groups, the disclaimer, …). Of a turn of the
-- assistant also: every item the tools returned in it (`found_item_ids` —
-- what grounding allows), how many item ids of the model it dropped, the
-- tool calls with their arguments and cut results, and the AI calls it made
-- (`ai_job_ids`; the cost of a dialog is theirs in `ai_job`).
--
-- After `assistant_retention_days` the texts are made impersonal by the
-- sweeper `assistant.anonymize-messages`: `text` and the tool calls are
-- emptied, `anonymized_at` set; the rows, the intents and the items stay for
-- the statistics.
CREATE TABLE assistant_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dialog_id UUID NOT NULL REFERENCES assistant_dialog (id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT,
  kind TEXT,
  intent TEXT,
  item_ids UUID[] NOT NULL DEFAULT '{}',
  found_item_ids UUID[] NOT NULL DEFAULT '{}',
  dropped_items INTEGER NOT NULL DEFAULT 0,
  reply JSONB,
  tool_calls JSONB NOT NULL DEFAULT '[]',
  ai_job_ids UUID[] NOT NULL DEFAULT '{}',
  anonymized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assistant_message_role_check CHECK (role IN ('user', 'assistant')),
  CONSTRAINT assistant_message_kind_check CHECK (
    kind IS NULL OR kind IN ('answer', 'question', 'off_topic', 'unavailable')
  ),
  CONSTRAINT assistant_message_intent_check CHECK (
    intent IS NULL OR intent IN ('pick_by_params', 'maintenance', 'symptom', 'other')
  ),
  CONSTRAINT assistant_message_dropped_check CHECK (dropped_items >= 0)
);

CREATE INDEX assistant_message_dialog_idx ON assistant_message (dialog_id, created_at);
-- The sweeper's work: messages not yet impersonal, oldest first.
CREATE INDEX assistant_message_retention_idx ON assistant_message (created_at)
  WHERE anonymized_at IS NULL;

-- «Пожаловаться на ответ»: one complaint per answer (a second one is the
-- first one again); the administrator resolves it with an internal comment.
CREATE TABLE assistant_complaint (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES assistant_message (id) ON DELETE CASCADE,
  dialog_id UUID NOT NULL REFERENCES assistant_dialog (id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  text TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  comment TEXT,
  resolved_by UUID REFERENCES admin_user (id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assistant_complaint_reason_check CHECK (
    reason IN ('wrong_item', 'not_compatible', 'offensive', 'other')
  ),
  CONSTRAINT assistant_complaint_status_check CHECK (status IN ('new', 'resolved')),
  CONSTRAINT assistant_complaint_resolved_check CHECK (
    status <> 'resolved' OR (resolved_at IS NOT NULL AND comment IS NOT NULL)
  )
);

CREATE UNIQUE INDEX assistant_complaint_message_key ON assistant_complaint (message_id);
CREATE INDEX assistant_complaint_status_idx ON assistant_complaint (status, created_at);

-- Down Migration
DROP TABLE assistant_complaint;
DROP TABLE assistant_message;
DROP TABLE assistant_dialog;

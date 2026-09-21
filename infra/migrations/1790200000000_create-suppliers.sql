-- Up Migration
-- Suppliers and how they come to the club (ARCHITECTURE.md 5.5, 4.26;
-- TASK-016; PRODUCT 12.1, 13, 14; D-026, D-030): the directory of cities,
-- the supplier's card (БИН, type, contact, time zone, states), its pickup
-- point with hours and days off, connection requests with notes, and
-- invitations of employees.
--
-- The city of a company was free text until now (TASK-006). Every such
-- text becomes a city of the directory — known names become that city with
-- its code and names in three languages, any other text a city of its own
-- (`source = 'migrated'`, code `migrated-<n>`, the text as its Russian
-- name) for the administrator to rename, merge by moving suppliers, or
-- archive. No company loses its city; `down` writes the texts back.

CREATE TABLE city (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name_ru TEXT NOT NULL,
  name_kk TEXT,
  name_en TEXT,
  time_zone TEXT NOT NULL DEFAULT 'Asia/Almaty',
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual',
  archived_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT city_code_key UNIQUE (code),
  CONSTRAINT city_code_check CHECK (code ~ '^[a-z][a-z0-9-]{1,49}$'),
  CONSTRAINT city_name_ru_check CHECK (btrim(name_ru) <> ''),
  CONSTRAINT city_name_kk_check CHECK (name_kk IS NULL OR btrim(name_kk) <> ''),
  CONSTRAINT city_name_en_check CHECK (name_en IS NULL OR btrim(name_en) <> ''),
  CONSTRAINT city_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT city_archived_check CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT city_source_check CHECK (source IN ('manual', 'migrated', 'operator')),
  CONSTRAINT city_version_check CHECK (version > 0)
);

-- The last line behind the check of names among all cities (the service
-- checks every language; here — Russian, case ignored).
CREATE UNIQUE INDEX city_name_ru_key ON city (lower(name_ru));

-- Cities of the companies created before the directory.
WITH known (code, name_ru, name_kk, name_en) AS (
  VALUES
    ('almaty', 'Алматы', 'Алматы', 'Almaty'),
    ('astana', 'Астана', 'Астана', 'Astana'),
    ('shymkent', 'Шымкент', 'Шымкент', 'Shymkent'),
    ('karaganda', 'Караганда', 'Қарағанды', 'Karaganda'),
    ('aktobe', 'Актобе', 'Ақтөбе', 'Aktobe'),
    ('taraz', 'Тараз', 'Тараз', 'Taraz'),
    ('pavlodar', 'Павлодар', 'Павлодар', 'Pavlodar'),
    ('ust-kamenogorsk', 'Усть-Каменогорск', 'Өскемен', 'Oskemen'),
    ('semey', 'Семей', 'Семей', 'Semey'),
    ('atyrau', 'Атырау', 'Атырау', 'Atyrau'),
    ('kostanay', 'Костанай', 'Қостанай', 'Kostanay'),
    ('kyzylorda', 'Кызылорда', 'Қызылорда', 'Kyzylorda'),
    ('uralsk', 'Уральск', 'Орал', 'Oral'),
    ('petropavlovsk', 'Петропавловск', 'Петропавл', 'Petropavl'),
    ('aktau', 'Актау', 'Ақтау', 'Aktau'),
    ('turkestan', 'Туркестан', 'Түркістан', 'Turkistan'),
    ('kokshetau', 'Кокшетау', 'Көкшетау', 'Kokshetau'),
    ('taldykorgan', 'Талдыкорган', 'Талдықорған', 'Taldykorgan')
),
-- One city per text, case and surrounding spaces ignored; its name is the
-- text as the first company wrote it.
texts AS (
  SELECT DISTINCT
    lower(btrim(city)) AS key,
    first_value(btrim(city)) OVER (PARTITION BY lower(btrim(city)) ORDER BY created_at, id) AS text
  FROM supplier
),
matched AS (
  SELECT t.key, t.text, k.code, k.name_ru, k.name_kk, k.name_en
  FROM texts t
  LEFT JOIN known k ON t.key IN (lower(k.code), lower(k.name_ru), lower(k.name_kk), lower(k.name_en))
)
INSERT INTO city (code, name_ru, name_kk, name_en, sort, source)
SELECT
  coalesce(code, 'migrated-' || row_number() OVER (PARTITION BY code IS NULL ORDER BY key)),
  coalesce(name_ru, text),
  name_kk,
  name_en,
  (row_number() OVER (ORDER BY coalesce(name_ru, text)) - 1)::int,
  'migrated'
FROM (SELECT DISTINCT ON (coalesce(code, key)) * FROM matched ORDER BY coalesce(code, key)) AS unique_cities;

ALTER TABLE supplier
  ADD COLUMN city_id UUID REFERENCES city (id),
  ADD COLUMN bin TEXT,
  ADD COLUMN type TEXT NOT NULL DEFAULT 'both',
  ADD COLUMN contact_name TEXT,
  ADD COLUMN contact_phone TEXT,
  ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'Asia/Almaty',
  ADD COLUMN pause_reason TEXT,
  ADD COLUMN pause_note TEXT,
  ADD COLUMN paused_at TIMESTAMPTZ,
  ADD COLUMN block_reason TEXT,
  ADD COLUMN blocked_at TIMESTAMPTZ,
  ADD COLUMN contract_signed_on DATE,
  ADD COLUMN verified_at TIMESTAMPTZ,
  ADD COLUMN lead_id UUID,
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

UPDATE supplier s SET city_id = c.id
FROM city c
WHERE lower(btrim(s.city)) IN (lower(c.code), lower(c.name_ru), lower(c.name_kk), lower(c.name_en));

-- A company created before TASK-016 offered what it offered: `both` keeps
-- every possibility until the administrator says otherwise. Its state is
-- carried over (a draft company is simply active: it never meant anything).
UPDATE supplier SET
  pause_reason = CASE WHEN status = 'paused' THEN 'admin' END,
  paused_at = CASE WHEN status = 'paused' THEN updated_at END,
  block_reason = CASE WHEN status = 'blocked' THEN 'Заблокирован до TASK-016' END,
  blocked_at = CASE WHEN status = 'blocked' THEN updated_at END,
  status = CASE WHEN status = 'draft' THEN 'active' ELSE status END;

ALTER TABLE supplier
  ALTER COLUMN city_id SET NOT NULL,
  DROP COLUMN city,
  DROP CONSTRAINT supplier_status_check,
  ADD CONSTRAINT supplier_bin_check CHECK (bin IS NULL OR bin ~ '^[0-9]{12}$'),
  ADD CONSTRAINT supplier_type_check CHECK (type IN ('goods', 'services', 'both')),
  ADD CONSTRAINT supplier_contact_phone_check CHECK (contact_phone IS NULL OR contact_phone ~ '^\+7[0-9]{10}$'),
  ADD CONSTRAINT supplier_pause_reason_check CHECK (pause_reason IS NULL OR pause_reason IN ('billing', 'admin')),
  ADD CONSTRAINT supplier_paused_check CHECK ((pause_reason IS NULL) = (paused_at IS NULL)),
  ADD CONSTRAINT supplier_blocked_check CHECK ((block_reason IS NULL) = (blocked_at IS NULL)),
  ADD CONSTRAINT supplier_verified_check CHECK ((verified_at IS NULL) = (contract_signed_on IS NULL)),
  ADD CONSTRAINT supplier_version_check CHECK (version > 0),
  -- `status` is what the pause and the blocking make it: one predicate for
  -- the showcase (`status = 'active'`, EPIC-07), and it can't drift.
  ADD CONSTRAINT supplier_status_check CHECK (
    status = CASE
      WHEN blocked_at IS NOT NULL THEN 'blocked'
      WHEN paused_at IS NOT NULL THEN 'paused'
      ELSE 'active'
    END
  );

-- One БИН — one supplier (TASK-016); companies from before may have none.
CREATE UNIQUE INDEX supplier_bin_key ON supplier (bin) WHERE bin IS NOT NULL;
CREATE INDEX supplier_city_idx ON supplier (city_id);

-- The pickup point (ARCHITECTURE 5.5): exactly one per supplier in the MVP
-- (several — BACKLOG). Its hours are seven days (ISO order, Monday first)
-- of up to three intervals each, in the supplier's time zone; `NULL` —
-- not given yet. Offers (EPIC-07) will point at it.
CREATE TABLE supplier_location (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  city_id UUID NOT NULL REFERENCES city (id),
  address TEXT,
  district TEXT,
  is_default BOOLEAN NOT NULL DEFAULT true,
  weekly_hours JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_location_address_check CHECK (address IS NULL OR btrim(address) <> ''),
  CONSTRAINT supplier_location_district_check CHECK (district IS NULL OR btrim(district) <> ''),
  CONSTRAINT supplier_location_hours_check CHECK (
    weekly_hours IS NULL
    OR (jsonb_typeof(weekly_hours) = 'array' AND jsonb_array_length(weekly_hours) = 7)
  )
);

CREATE UNIQUE INDEX supplier_location_default_key ON supplier_location (supplier_id) WHERE is_default;

INSERT INTO supplier_location (supplier_id, city_id)
SELECT id, city_id FROM supplier;

-- Dates the point doesn't work (holidays, a vacation). Past dates stay as
-- history; the card shows those from today on.
CREATE TABLE supplier_closed_date (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES supplier_location (id),
  closed_on DATE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_closed_date_key UNIQUE (location_id, closed_on),
  CONSTRAINT supplier_closed_date_note_check CHECK (note IS NULL OR btrim(note) <> '')
);

-- A connection request (PRODUCT 12.1; SCREENS S-PUB-01, A-SUP-01). Several
-- requests may name one БИН — they are linked by it, never merged. A
-- request from the public form keeps when and to which text version
-- consent was given; one added by hand has none.
CREATE TABLE supplier_lead (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  bin TEXT NOT NULL,
  city_id UUID NOT NULL REFERENCES city (id),
  type TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  reject_reason TEXT,
  language TEXT,
  consent_at TIMESTAMPTZ,
  consent_version TEXT,
  supplier_id UUID REFERENCES supplier (id),
  created_by_admin_id UUID REFERENCES admin_user (id),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_lead_company_name_check CHECK (btrim(company_name) <> ''),
  CONSTRAINT supplier_lead_bin_check CHECK (bin ~ '^[0-9]{12}$'),
  CONSTRAINT supplier_lead_type_check CHECK (type IN ('goods', 'services', 'both')),
  CONSTRAINT supplier_lead_contact_name_check CHECK (btrim(contact_name) <> ''),
  CONSTRAINT supplier_lead_phone_check CHECK (phone ~ '^\+7[0-9]{10}$'),
  CONSTRAINT supplier_lead_source_check CHECK (source IN ('public_form', 'admin')),
  CONSTRAINT supplier_lead_status_check CHECK (
    status IN ('new', 'contacted', 'meeting', 'contract_signed', 'onboarded', 'rejected')
  ),
  CONSTRAINT supplier_lead_rejected_check CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  CONSTRAINT supplier_lead_onboarded_check CHECK ((status = 'onboarded') = (supplier_id IS NOT NULL)),
  CONSTRAINT supplier_lead_language_check CHECK (language IS NULL OR language IN ('kk', 'ru', 'en')),
  CONSTRAINT supplier_lead_consent_check CHECK (
    source <> 'public_form'
    OR (consent_at IS NOT NULL AND consent_version IS NOT NULL AND language IS NOT NULL)
  ),
  CONSTRAINT supplier_lead_version_check CHECK (version > 0)
);

CREATE INDEX supplier_lead_created_idx ON supplier_lead (created_at DESC, id DESC);
CREATE INDEX supplier_lead_bin_idx ON supplier_lead (bin);
CREATE INDEX supplier_lead_phone_idx ON supplier_lead (phone, created_at);

ALTER TABLE supplier
  ADD CONSTRAINT supplier_lead_fkey FOREIGN KEY (lead_id) REFERENCES supplier_lead (id);

CREATE TABLE supplier_lead_note (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES supplier_lead (id),
  text TEXT NOT NULL,
  author_admin_id UUID REFERENCES admin_user (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_lead_note_text_check CHECK (btrim(text) <> '')
);

CREATE INDEX supplier_lead_note_lead_idx ON supplier_lead_note (lead_id, created_at DESC);

-- An invitation to an employee (SCREENS W-08), sent by a background job
-- through the message channel (test only until TASK-026). One row per
-- sending, first or again, so the frequency of resending is counted here.
CREATE TABLE supplier_invitation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES supplier (id),
  member_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  channel TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  requested_by_admin_id UUID REFERENCES admin_user (id),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invitation_member_fkey
    FOREIGN KEY (member_id, supplier_id) REFERENCES supplier_member (id, supplier_id),
  CONSTRAINT supplier_invitation_status_check CHECK (status IN ('queued', 'sent', 'failed')),
  CONSTRAINT supplier_invitation_sent_check CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT supplier_invitation_channel_check CHECK (channel IS NULL OR channel IN ('test', 'whatsapp', 'sms'))
);

CREATE INDEX supplier_invitation_member_idx ON supplier_invitation (member_id, created_at DESC);
CREATE INDEX supplier_invitation_sent_idx ON supplier_invitation (sent_at DESC) WHERE sent_at IS NOT NULL;

-- Down Migration
DROP TABLE supplier_invitation;
DROP TABLE supplier_lead_note;
ALTER TABLE supplier DROP CONSTRAINT supplier_lead_fkey;
DROP TABLE supplier_lead;
DROP TABLE supplier_closed_date;
DROP TABLE supplier_location;
DROP INDEX supplier_city_idx;
DROP INDEX supplier_bin_key;

-- The city goes back to its text: the Russian name of the directory city.
ALTER TABLE supplier ADD COLUMN city TEXT;
UPDATE supplier s SET city = c.name_ru FROM city c WHERE c.id = s.city_id;
ALTER TABLE supplier
  ALTER COLUMN city SET NOT NULL,
  DROP CONSTRAINT supplier_status_check,
  DROP CONSTRAINT supplier_bin_check,
  DROP CONSTRAINT supplier_type_check,
  DROP CONSTRAINT supplier_contact_phone_check,
  DROP CONSTRAINT supplier_pause_reason_check,
  DROP CONSTRAINT supplier_paused_check,
  DROP CONSTRAINT supplier_blocked_check,
  DROP CONSTRAINT supplier_verified_check,
  DROP CONSTRAINT supplier_version_check,
  DROP COLUMN city_id,
  DROP COLUMN bin,
  DROP COLUMN type,
  DROP COLUMN contact_name,
  DROP COLUMN contact_phone,
  DROP COLUMN time_zone,
  DROP COLUMN pause_reason,
  DROP COLUMN pause_note,
  DROP COLUMN paused_at,
  DROP COLUMN block_reason,
  DROP COLUMN blocked_at,
  DROP COLUMN contract_signed_on,
  DROP COLUMN verified_at,
  DROP COLUMN lead_id,
  DROP COLUMN version,
  ADD CONSTRAINT supplier_status_check CHECK (status IN ('draft', 'active', 'paused', 'blocked'));
DROP TABLE city;

-- Up Migration

-- Single account per phone number (ARCHITECTURE.md 5.1): the identity a
-- person keeps whether they act as a user, a supplier employee or an admin.
-- Role-specific tables (user_profile, supplier_member, admin_user, ...)
-- arrive with the tasks that own that logic (EPIC-02).
CREATE TABLE account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  consent_phone_share_at TIMESTAMPTZ,
  consent_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_status_check CHECK (status IN ('active', 'blocked'))
);

CREATE UNIQUE INDEX account_phone_key ON account (phone);

-- Down Migration

DROP TABLE account;

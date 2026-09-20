-- Up Migration
-- Photos of catalog items (ARCHITECTURE.md 5.2, 4.22; PRODUCT 7.6;
-- TASK-013). A photo belongs to the item, not to a supplier: one picture
-- serves every supplier of that item. Its source is always known, and only
-- a photo a person approved is shown to clients.
--
-- Nothing here is deleted while its files exist: "remove" is a status plus
-- `removed_at`, and a background job removes the objects after their
-- retention (so a mistake can be undone within it). The row itself stays
-- as the history of what was shown and why it was refused.

CREATE TABLE item_photo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES catalog_item (id),
  -- Where the picture came from (PRODUCT 7.6). The three that mean "found
  -- on the internet" carry the page they were taken from; `supplier_photo`
  -- and `admin_upload` are our own files. There is no value for a generated
  -- picture: generating pictures of goods is forbidden (ARCHITECTURE 9.7).
  source_type TEXT NOT NULL,
  source_url TEXT,
  -- What the search found, for a candidate from AI (EPIC-17): the
  -- independent shops the same picture was seen in.
  source_evidence JSONB,
  status TEXT NOT NULL DEFAULT 'proposed',
  rejection_reason TEXT,
  proposed_by TEXT NOT NULL DEFAULT 'admin',
  -- How sure the search was (0…1) and the call that produced it (EPIC-17).
  ai_score NUMERIC,
  ai_job_id UUID REFERENCES ai_job (id),
  -- The stored original: its type, size and pixels after the metadata that
  -- came with the file (camera, coordinates) was stripped.
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  -- SHA-256 of the stored original, in hexadecimal: the same picture is
  -- not kept twice for one item (the partial unique index below).
  checksum TEXT NOT NULL,
  -- Position among the approved photos of the item; the primary one is
  -- named by `catalog_item.primary_photo_id`.
  sort INTEGER NOT NULL DEFAULT 0,
  uploaded_by UUID REFERENCES account (id),
  reviewed_by UUID REFERENCES account (id),
  reviewed_at TIMESTAMPTZ,
  -- When it was rejected or removed: the moment the file retention counts
  -- from. `files_deleted_at` — when the objects were actually removed;
  -- after that nothing brings the photo back.
  removed_at TIMESTAMPTZ,
  files_deleted_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- `catalog_item.primary_photo_id` points here through this key, so the
  -- primary photo of an item can only be a photo of that very item.
  CONSTRAINT item_photo_id_item_key UNIQUE (id, item_id),
  CONSTRAINT item_photo_source_type_check CHECK (source_type IN (
    'manufacturer', 'official_catalog', 'multi_store', 'supplier_photo', 'admin_upload'
  )),
  -- A picture found on the internet always names the page it came from.
  CONSTRAINT item_photo_source_url_check CHECK (
    (source_type NOT IN ('manufacturer', 'official_catalog', 'multi_store')
      OR source_url IS NOT NULL)
    AND (source_url IS NULL OR source_url ~ '^https?://')
  ),
  CONSTRAINT item_photo_status_check CHECK (
    status IN ('proposed', 'approved', 'rejected', 'deleted')
  ),
  CONSTRAINT item_photo_removed_at_check CHECK (
    (status IN ('rejected', 'deleted')) = (removed_at IS NOT NULL)
  ),
  CONSTRAINT item_photo_files_deleted_check CHECK (
    files_deleted_at IS NULL OR removed_at IS NOT NULL
  ),
  -- A refusal always says why (PRODUCT 7.6, TASK-013 requirement 2).
  CONSTRAINT item_photo_rejection_reason_check CHECK (
    (status <> 'rejected' OR rejection_reason IS NOT NULL)
    AND (rejection_reason IS NULL OR btrim(rejection_reason) <> '')
  ),
  CONSTRAINT item_photo_proposed_by_check CHECK (proposed_by IN ('admin', 'supplier', 'ai')),
  CONSTRAINT item_photo_ai_score_check CHECK (ai_score IS NULL OR (ai_score >= 0 AND ai_score <= 1)),
  CONSTRAINT item_photo_content_type_check CHECK (
    content_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  CONSTRAINT item_photo_size_check CHECK (byte_size > 0 AND width > 0 AND height > 0),
  CONSTRAINT item_photo_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT item_photo_version_check CHECK (version > 0)
);

-- The same picture is not uploaded twice to one item (TASK-013
-- requirement 1). A removed photo is out of the way: the same picture can
-- be uploaded again after it was rejected or deleted.
CREATE UNIQUE INDEX item_photo_item_checksum_key ON item_photo (item_id, checksum)
  WHERE removed_at IS NULL;
-- The photos of an item, in their order.
CREATE INDEX item_photo_item_idx ON item_photo (item_id, sort, created_at);
-- What the deferred deletion job claims.
CREATE INDEX item_photo_removed_idx ON item_photo (removed_at)
  WHERE removed_at IS NOT NULL AND files_deleted_at IS NULL;

-- One stored object per size of one photo (ARCHITECTURE 4.22): the
-- original the administrator sees, the card-size picture and the thumbnail
-- lists show. The row is the only record that the object exists: a file in
-- the bucket with no row here is rubbish left by an interrupted upload and
-- the cleanup job removes it.
CREATE TABLE item_photo_file (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id UUID NOT NULL REFERENCES item_photo (id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT item_photo_file_photo_variant_key UNIQUE (photo_id, variant),
  CONSTRAINT item_photo_file_storage_key_key UNIQUE (storage_key),
  CONSTRAINT item_photo_file_variant_check CHECK (variant IN ('original', 'card', 'thumb')),
  CONSTRAINT item_photo_file_storage_key_check CHECK (btrim(storage_key) <> ''),
  CONSTRAINT item_photo_file_size_check CHECK (byte_size > 0 AND width > 0 AND height > 0)
);

-- The photo shown in lists (ARCHITECTURE 5.2). The composite foreign key
-- lets only a photo of this very item take the role; that it is approved
-- is the service's rule (a check across tables would need a trigger).
ALTER TABLE catalog_item ADD COLUMN primary_photo_id UUID;
ALTER TABLE catalog_item ADD CONSTRAINT catalog_item_primary_photo_fkey
  FOREIGN KEY (primary_photo_id, id) REFERENCES item_photo (id, item_id);

-- Down Migration
ALTER TABLE catalog_item DROP CONSTRAINT catalog_item_primary_photo_fkey;
ALTER TABLE catalog_item DROP COLUMN primary_photo_id;
DROP TABLE item_photo_file;
DROP TABLE item_photo;

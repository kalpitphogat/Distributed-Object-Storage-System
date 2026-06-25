-- Migration: initial schema
-- Implements the full DDL from §6 of the build plan.

-- Buckets: top-level namespace
CREATE TABLE buckets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(63) UNIQUE NOT NULL,
  owner_id        UUID NOT NULL,
  versioning_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Access keys for auth + HMAC signing
CREATE TABLE access_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_key_id   VARCHAR(40) UNIQUE NOT NULL,
  secret_key_hash VARCHAR(128) NOT NULL,   -- bcrypt hash, never store plaintext
  owner_id        UUID NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Objects: a key within a bucket. The "current pointer".
CREATE TABLE objects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id         UUID NOT NULL REFERENCES buckets(id),
  object_key        TEXT NOT NULL,
  latest_version_id UUID,                 -- FK added after object_versions exists
  is_deleted        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, object_key)
);

-- Object versions: append-only history per object
CREATE TABLE object_versions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id        UUID NOT NULL REFERENCES objects(id),
  version_number   BIGINT NOT NULL,        -- monotonic per object, not global
  size_bytes       BIGINT NOT NULL DEFAULT 0,
  content_sha256   CHAR(64),               -- whole-object hash (for single-chunk objects)
  etag             VARCHAR(64) NOT NULL,
  is_delete_marker BOOLEAN NOT NULL DEFAULT false,
  storage_class    VARCHAR(16) NOT NULL DEFAULT 'STANDARD',  -- STANDARD | COLD
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (object_id, version_number)
);

ALTER TABLE objects
  ADD CONSTRAINT fk_latest_version
  FOREIGN KEY (latest_version_id) REFERENCES object_versions(id);

-- Chunks: content-addressable, deduplicated by hash
-- WHY: two objects with identical 8 MB blocks share one chunk row + one copy on disk.
-- ref_count prevents premature GC while any manifest still references this chunk.
CREATE TABLE chunks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_sha256 CHAR(64) UNIQUE NOT NULL,
  size_bytes     INTEGER NOT NULL,
  ref_count      INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Manifest: ordered list of chunks that make up one object version
CREATE TABLE object_version_chunks (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_version_id UUID NOT NULL REFERENCES object_versions(id),
  chunk_id          UUID NOT NULL REFERENCES chunks(id),
  chunk_index       INTEGER NOT NULL,     -- 0-based order within the object
  byte_offset       BIGINT NOT NULL,      -- cumulative offset, used for Range lookups
  UNIQUE (object_version_id, chunk_index)
);
-- Index on byte_offset enables O(log n) range lookup without scanning all chunks
CREATE INDEX idx_ovc_offset ON object_version_chunks (object_version_id, byte_offset);

-- Storage nodes participating in the ring
CREATE TABLE storage_nodes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_url           VARCHAR(255) NOT NULL,
  status             VARCHAR(16) NOT NULL DEFAULT 'active',  -- active|draining|down
  capacity_bytes     BIGINT NOT NULL,
  used_bytes         BIGINT NOT NULL DEFAULT 0,
  virtual_node_count INTEGER NOT NULL DEFAULT 150,
  last_heartbeat_at  TIMESTAMPTZ
);

-- Which nodes hold a copy of which chunk, and replica health
CREATE TABLE chunk_replicas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id        UUID NOT NULL REFERENCES chunks(id),
  storage_node_id UUID NOT NULL REFERENCES storage_nodes(id),
  status          VARCHAR(16) NOT NULL DEFAULT 'active',  -- active|stale|missing
  last_verified_at TIMESTAMPTZ,
  UNIQUE (chunk_id, storage_node_id)
);
CREATE INDEX idx_replicas_chunk ON chunk_replicas (chunk_id);

-- Multipart upload session
CREATE TABLE multipart_uploads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- this is the uploadId
  bucket_id    UUID NOT NULL REFERENCES buckets(id),
  object_key   TEXT NOT NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'in_progress', -- in_progress|completed|aborted
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE multipart_parts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id   UUID NOT NULL REFERENCES multipart_uploads(id),
  part_number INTEGER NOT NULL,
  chunk_id    UUID REFERENCES chunks(id),
  etag        VARCHAR(64),
  size_bytes  INTEGER,
  UNIQUE (upload_id, part_number)
);

-- Lifecycle rules per bucket
CREATE TABLE lifecycle_policies (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id                     UUID NOT NULL REFERENCES buckets(id),
  prefix                        TEXT,
  expire_after_days             INTEGER,
  transition_to_cold_after_days INTEGER,
  enabled                       BOOLEAN NOT NULL DEFAULT true
);

-- Rolling counters for the admin analytics dashboard
CREATE TABLE bucket_stats (
  bucket_id           UUID PRIMARY KEY REFERENCES buckets(id),
  total_objects       BIGINT NOT NULL DEFAULT 0,
  total_bytes         BIGINT NOT NULL DEFAULT 0,
  bandwidth_bytes_30d BIGINT NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

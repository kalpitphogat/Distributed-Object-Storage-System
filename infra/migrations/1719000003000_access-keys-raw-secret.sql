-- Add raw_secret column to access_keys for HMAC presigned URL signing.
-- In production this would be envelope-encrypted at rest; for this portfolio
-- project we accept the simplification and document it in DECISIONS.md.
ALTER TABLE access_keys
  ADD COLUMN IF NOT EXISTS raw_secret VARCHAR(256);

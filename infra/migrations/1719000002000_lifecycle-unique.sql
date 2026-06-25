-- Add unique constraint on lifecycle_policies(bucket_id) so PUT /lifecycle
-- can upsert rather than accumulate duplicate rows per bucket.
ALTER TABLE lifecycle_policies
  ADD CONSTRAINT uq_lifecycle_bucket UNIQUE (bucket_id);

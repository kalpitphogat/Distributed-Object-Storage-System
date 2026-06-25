-- Migration: seed storage nodes for the consistent hash ring.
-- Each row represents one MinIO container in the Docker Compose cluster.
-- virtual_node_count = 150 matches Apache Cassandra's default and gives smooth
-- load distribution while keeping ring memory manageable (~6 KB per node).

INSERT INTO storage_nodes (node_url, status, capacity_bytes, virtual_node_count)
VALUES
  ('http://minio-1:9000', 'active', 107374182400, 150),
  ('http://minio-2:9000', 'active', 107374182400, 150),
  ('http://minio-3:9000', 'active', 107374182400, 150),
  ('http://minio-4:9000', 'active', 107374182400, 150),
  ('http://minio-5:9000', 'active', 107374182400, 150)
ON CONFLICT DO NOTHING;

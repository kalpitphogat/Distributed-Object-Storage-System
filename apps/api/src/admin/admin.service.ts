import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

export interface BucketStats {
  bucketId: string;
  name: string;
  totalObjects: number;
  totalBytes: number;
  bandwidthBytes30d: number;
  updatedAt: string;
}

export interface NodeHealth {
  id: string;
  nodeUrl: string;
  status: string;
  capacityBytes: number;
  usedBytes: number;
  virtualNodeCount: number;
  lastHeartbeatAt: string | null;
  replicaCount: number;
}

@Injectable()
export class AdminService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getBucketStats(bucketName?: string): Promise<BucketStats[]> {
    const res = await this.pool.query<{
      bucket_id: string;
      name: string;
      total_objects: string;
      total_bytes: string;
      bandwidth_bytes_30d: string;
      updated_at: string;
    }>(
      `SELECT bs.bucket_id, b.name, bs.total_objects, bs.total_bytes,
              bs.bandwidth_bytes_30d, bs.updated_at
       FROM bucket_stats bs
       JOIN buckets b ON b.id = bs.bucket_id
       ${bucketName ? 'WHERE b.name = $1' : ''}
       ORDER BY bs.total_bytes DESC`,
      bucketName ? [bucketName] : [],
    );
    return res.rows.map((r) => ({
      bucketId: r.bucket_id,
      name: r.name,
      totalObjects: Number(r.total_objects),
      totalBytes: Number(r.total_bytes),
      bandwidthBytes30d: Number(r.bandwidth_bytes_30d),
      updatedAt: r.updated_at,
    }));
  }

  async getNodeHealth(): Promise<NodeHealth[]> {
    const res = await this.pool.query<{
      id: string;
      node_url: string;
      status: string;
      capacity_bytes: string;
      used_bytes: string;
      virtual_node_count: number;
      last_heartbeat_at: string | null;
      replica_count: string;
    }>(
      `SELECT sn.id, sn.node_url, sn.status, sn.capacity_bytes, sn.used_bytes,
              sn.virtual_node_count, sn.last_heartbeat_at,
              COUNT(cr.id) AS replica_count
       FROM storage_nodes sn
       LEFT JOIN chunk_replicas cr ON cr.storage_node_id = sn.id AND cr.status = 'active'
       GROUP BY sn.id
       ORDER BY sn.node_url`,
    );
    return res.rows.map((r) => ({
      id: r.id,
      nodeUrl: r.node_url,
      status: r.status,
      capacityBytes: Number(r.capacity_bytes),
      usedBytes: Number(r.used_bytes),
      virtualNodeCount: r.virtual_node_count,
      lastHeartbeatAt: r.last_heartbeat_at,
      replicaCount: Number(r.replica_count),
    }));
  }

  async getGcStats(): Promise<{
    totalChunks: number;
    orphanedChunks: number;
    totalBytes: number;
  }> {
    const res = await this.pool.query<{
      total_chunks: string;
      orphaned_chunks: string;
      total_bytes: string;
    }>(
      `SELECT
         COUNT(*) AS total_chunks,
         COUNT(*) FILTER (WHERE ref_count = 0) AS orphaned_chunks,
         COALESCE(SUM(size_bytes), 0) AS total_bytes
       FROM chunks`,
    );
    const row = res.rows[0];
    return {
      totalChunks: Number(row.total_chunks),
      orphanedChunks: Number(row.orphaned_chunks),
      totalBytes: Number(row.total_bytes),
    };
  }
}

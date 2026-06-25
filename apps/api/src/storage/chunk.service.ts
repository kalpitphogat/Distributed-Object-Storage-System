import { createHash } from 'crypto';
import { Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { PG_POOL } from '../database/database.module';
import { REDIS_CLIENT } from '../redis/redis.module';
import { StorageService } from './storage.service';
import { RingService } from './ring.service';

export interface ChunkRef {
  id: string;
  sha256: string;
  sizeBytes: number;
}

// Replication configuration — configurable via env for testing with fewer nodes.
const REPLICATION_FACTOR = Number(process.env['REPLICATION_FACTOR'] ?? 3);
const WRITE_QUORUM = Number(process.env['WRITE_QUORUM'] ?? 2);

// Hot-chunk cache: cache chunk bytes in Redis to avoid MinIO GETs on repeat reads.
// WHY: a popular blob (e.g. the favicon) may be fetched thousands of times per minute;
// caching its bytes in Redis means those reads never touch the storage ring.
const CHUNK_CACHE_PREFIX = 'chunk:bytes:';
const CHUNK_CACHE_TTL_SEC = 300; // 5-minute TTL — evicted if not re-read
const CHUNK_CACHE_MAX_BYTES = 1 * 1024 * 1024; // only cache chunks ≤ 1 MB

@Injectable()
export class ChunkService {
  private readonly logger = new Logger(ChunkService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly storage: StorageService,
    private readonly ring: RingService,
  ) {}

  /**
   * Hash → dedup check → write to RF target nodes → quorum assert → DB upsert → replica records.
   *
   * WHY ref_count starts at 0: the manifest transaction (writeObjectMetadata) increments
   * it when the version row is committed.  A crash before that leaves ref_count=0 and the
   * GC worker reclaims the orphaned chunk — no data is silently leaked.
   */
  async writeChunk(body: Buffer): Promise<ChunkRef> {
    const sha256 = createHash('sha256').update(body).digest('hex');
    const sizeBytes = body.length;

    // Dedup: if chunk already in DB, skip the network write entirely.
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM chunks WHERE content_sha256 = $1`,
      [sha256],
    );
    if (existing.rows.length > 0) {
      return { id: existing.rows[0].id, sha256, sizeBytes };
    }

    // Select RF target nodes from the ring.
    const targetNodes = this.ring.getReplicaNodes(sha256, REPLICATION_FACTOR);
    if (targetNodes.length === 0) {
      throw new InternalServerErrorException('No storage nodes available in the ring');
    }

    // Write to all target nodes concurrently.
    const results = await Promise.allSettled(
      targetNodes.map((url) => this.storage.putChunkToNode(sha256, body, url)),
    );

    const successCount = results.filter((r) => r.status === 'fulfilled').length;
    // W=2 of RF=3 — acknowledge write once quorum confirms durability.
    // The third write (if it failed) is retried by the anti-entropy worker.
    const requiredAcks = Math.min(WRITE_QUORUM, targetNodes.length);
    if (successCount < requiredAcks) {
      throw new InternalServerErrorException(
        `Write quorum not met: ${successCount}/${targetNodes.length} nodes acked (need ${requiredAcks})`,
      );
    }

    // Upsert chunk row; ON CONFLICT handles concurrent writers racing on the same hash.
    const chunkRes = await this.pool.query<{ id: string }>(
      `INSERT INTO chunks (content_sha256, size_bytes, ref_count)
       VALUES ($1, $2, 0)
       ON CONFLICT (content_sha256) DO UPDATE SET ref_count = chunks.ref_count
       RETURNING id`,
      [sha256, sizeBytes],
    );
    const chunkId = chunkRes.rows[0].id;

    // Record which nodes successfully stored this chunk.
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        await this.pool.query(
          `INSERT INTO chunk_replicas (chunk_id, storage_node_id, status)
           SELECT $1, sn.id, 'active'
           FROM storage_nodes sn
           WHERE sn.node_url = $2
           ON CONFLICT (chunk_id, storage_node_id) DO UPDATE SET status = 'active'`,
          [chunkId, targetNodes[i]],
        );
      }
    }

    return { id: chunkId, sha256, sizeBytes };
  }

  /**
   * Read a chunk from the best available replica with SHA-256 verification.
   *
   * WHY hash verification on reads: content-addressable storage means the hash
   * IS the identity — any bit-flip produces a wrong hash and is immediately
   * detectable.  This is the "strong read consistency" benefit of CAS even with
   * R=1 (we don't need a read quorum vote because we can verify locally).
   *
   * If a replica fails checksum: mark it stale and try the next one.
   * After a successful read from a degraded set: schedule async repair.
   */
  async readChunk(sha256: string): Promise<Buffer> {
    // Phase 6 hot-chunk cache: serve from Redis if recently read.
    const cacheKey = `${CHUNK_CACHE_PREFIX}${sha256}`;
    const cached = await this.redis.getBuffer(cacheKey);
    if (cached) {
      return cached;
    }

    // Get active replicas from DB.
    const replicaRes = await this.pool.query<{ node_url: string }>(
      `SELECT sn.node_url
       FROM chunk_replicas cr
       JOIN storage_nodes sn ON sn.id = cr.storage_node_id
       JOIN chunks c ON c.id = cr.chunk_id
       WHERE c.content_sha256 = $1
         AND cr.status = 'active'
         AND sn.status = 'active'`,
      [sha256],
    );

    let nodeUrls = replicaRes.rows.map((r) => r.node_url);

    // Fallback for legacy chunks written before Phase 3 (no replica records):
    // try every known node rather than failing immediately.
    if (nodeUrls.length === 0) {
      nodeUrls = this.storage.nodeUrls();
    }

    const failedNodes: string[] = [];

    for (const nodeUrl of nodeUrls) {
      try {
        const bytes = await this.storage.getChunkFromNode(sha256, nodeUrl);
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== sha256) {
          this.logger.warn(`Checksum mismatch on ${nodeUrl} for chunk ${sha256.slice(0, 8)}…`);
          await this.markReplicaStale(sha256, nodeUrl);
          failedNodes.push(nodeUrl);
          continue;
        }
        // Good read — schedule async repair for any failed replicas seen so far.
        if (failedNodes.length > 0) {
          this.repairReplicas(sha256, bytes, failedNodes).catch(() => {});
        }
        // Cache small chunks in Redis to absorb hot-read traffic.
        if (bytes.length <= CHUNK_CACHE_MAX_BYTES) {
          await this.redis.set(cacheKey, bytes, 'EX', CHUNK_CACHE_TTL_SEC);
        }
        return bytes;
      } catch {
        failedNodes.push(nodeUrl);
      }
    }

    throw new InternalServerErrorException(
      `All replicas failed for chunk ${sha256.slice(0, 8)}… (tried ${nodeUrls.length} node(s))`,
    );
  }

  /** Read a byte range from a chunk (used by range-request handler). */
  async readChunkRange(sha256: string, start: number, end: number): Promise<Buffer> {
    const replicaRes = await this.pool.query<{ node_url: string }>(
      `SELECT sn.node_url
       FROM chunk_replicas cr
       JOIN storage_nodes sn ON sn.id = cr.storage_node_id
       JOIN chunks c ON c.id = cr.chunk_id
       WHERE c.content_sha256 = $1 AND cr.status = 'active' AND sn.status = 'active'`,
      [sha256],
    );
    let nodeUrls = replicaRes.rows.map((r) => r.node_url);
    if (nodeUrls.length === 0) nodeUrls = this.storage.nodeUrls();

    for (const nodeUrl of nodeUrls) {
      try {
        return await this.storage.getChunkRangeFromNode(sha256, nodeUrl, start, end);
      } catch {
        // try next replica
      }
    }
    throw new InternalServerErrorException(`Range read failed for chunk ${sha256.slice(0, 8)}…`);
  }

  private async markReplicaStale(sha256: string, nodeUrl: string): Promise<void> {
    await this.pool.query(
      `UPDATE chunk_replicas cr SET status = 'stale'
       FROM chunks c, storage_nodes sn
       WHERE cr.chunk_id = c.id AND cr.storage_node_id = sn.id
         AND c.content_sha256 = $1 AND sn.node_url = $2`,
      [sha256, nodeUrl],
    );
  }

  /** Async read-repair: copy good bytes to each stale/failed replica. */
  private async repairReplicas(
    sha256: string,
    goodBytes: Buffer,
    badNodes: string[],
  ): Promise<void> {
    for (const nodeUrl of badNodes) {
      try {
        await this.storage.putChunkToNode(sha256, goodBytes, nodeUrl);
        await this.pool.query(
          `UPDATE chunk_replicas cr SET status = 'active', last_verified_at = now()
           FROM chunks c, storage_nodes sn
           WHERE cr.chunk_id = c.id AND cr.storage_node_id = sn.id
             AND c.content_sha256 = $1 AND sn.node_url = $2`,
          [sha256, nodeUrl],
        );
        this.logger.log(`Read-repair: restored chunk ${sha256.slice(0, 8)}… on ${nodeUrl}`);
      } catch (err) {
        this.logger.error(`Read-repair failed for ${sha256.slice(0, 8)}… on ${nodeUrl}: ${String(err)}`);
      }
    }
  }
}

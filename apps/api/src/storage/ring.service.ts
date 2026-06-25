import { Injectable, OnModuleInit, Inject, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { HashRing } from '@mini-s3/hash-ring';
import { PG_POOL } from '../database/database.module';
import { REDIS_CLIENT } from '../redis/redis.module';

interface StorageNodeRow {
  id: string;
  node_url: string;
  virtual_node_count: number;
}

const RING_CACHE_KEY = 'ring:snapshot';
const RING_TTL_SECONDS = 300; // 5-minute cache — ring rarely changes

/**
 * Manages the consistent hash ring across the storage node cluster.
 *
 * WHY RING CACHE IN REDIS: Every API replica needs the same ring so that
 * chunk X always maps to the same 3 nodes regardless of which API pod handles
 * the request.  Redis is the shared coordination point; each API instance
 * builds a local in-memory HashRing from the cached snapshot.
 */
@Injectable()
export class RingService implements OnModuleInit {
  private readonly logger = new Logger(RingService.name);
  private ring = new HashRing();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.logger.log(`RingService: ring loaded with ${this.ring.nodeCount} nodes`);
  }

  /** Load ring from Redis cache; fall back to DB if cache is cold. */
  async refresh(): Promise<void> {
    const cached = await this.redis.get(RING_CACHE_KEY);
    if (cached) {
      this.ring = HashRing.deserialize(cached);
      return;
    }
    await this.reloadFromDb();
  }

  /** Rebuild ring from DB (called on cache miss or after node add/remove). */
  async reloadFromDb(): Promise<void> {
    const res = await this.pool.query<StorageNodeRow>(
      `SELECT id, node_url, virtual_node_count
       FROM storage_nodes
       WHERE status = 'active'
       ORDER BY node_url`,
    );
    this.ring = new HashRing();
    for (const row of res.rows) {
      this.ring.addNode(row.node_url, row.virtual_node_count);
    }
    await this.redis.set(RING_CACHE_KEY, this.ring.serialize(), 'EX', RING_TTL_SECONDS);
    this.logger.log(`RingService: reloaded ${res.rows.length} nodes from DB`);
  }

  /**
   * Returns `count` distinct physical node URLs for the given chunk hash,
   * walking clockwise around the ring from hash(chunkHash).
   * Used by ChunkService to select write targets (RF=3) and read replicas.
   */
  getReplicaNodes(chunkHash: string, count: number): string[] {
    return this.ring.getReplicaNodes(chunkHash, count);
  }

  get nodeCount(): number {
    return this.ring.nodeCount;
  }
}

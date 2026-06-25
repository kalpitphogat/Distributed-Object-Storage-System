import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { Bucket } from '@mini-s3/shared-types';

// Placeholder owner until Phase 5 adds real auth/access-key lookup.
const SYSTEM_OWNER_ID = '00000000-0000-0000-0000-000000000001';

// S3 bucket name rules: 3-63 chars, lowercase letters/digits/hyphens,
// must start and end with letter or digit, no consecutive hyphens.
function isValidBucketName(name: string): boolean {
  if (name.length < 3 || name.length > 63) return false;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) return false;
  if (/--/.test(name)) return false;
  return true;
}

@Injectable()
export class BucketsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(name: string): Promise<Bucket> {
    if (!isValidBucketName(name)) {
      throw new BadRequestException(
        'Invalid bucket name. Must be 3-63 lowercase letters, digits, or hyphens; ' +
          'must start and end with a letter or digit; no consecutive hyphens.',
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<Record<string, unknown>>(
        `INSERT INTO buckets (name, owner_id) VALUES ($1, $2) RETURNING *`,
        [name, SYSTEM_OWNER_ID],
      );
      await client.query(
        `INSERT INTO bucket_stats (bucket_id) VALUES ($1)`,
        [res.rows[0]['id']],
      );
      await client.query('COMMIT');
      return this.toModel(res.rows[0]);
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException(`Bucket "${name}" already exists`);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async findAll(): Promise<Bucket[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM buckets ORDER BY created_at DESC`,
    );
    return res.rows.map((r) => this.toModel(r));
  }

  async findOne(name: string): Promise<Bucket> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM buckets WHERE name = $1`,
      [name],
    );
    if (res.rows.length === 0) {
      throw new NotFoundException(`Bucket "${name}" not found`);
    }
    return this.toModel(res.rows[0]);
  }

  async delete(name: string): Promise<void> {
    const res = await this.pool.query(
      `DELETE FROM buckets WHERE name = $1 RETURNING id`,
      [name],
    );
    if (res.rowCount === 0) {
      throw new NotFoundException(`Bucket "${name}" not found`);
    }
  }

  async setVersioning(name: string, enabled: boolean): Promise<Bucket> {
    const res = await this.pool.query<Record<string, unknown>>(
      `UPDATE buckets SET versioning_enabled = $1, updated_at = now()
       WHERE name = $2 RETURNING *`,
      [enabled, name],
    );
    if (res.rowCount === 0) {
      throw new NotFoundException(`Bucket "${name}" not found`);
    }
    return this.toModel(res.rows[0]);
  }

  async setLifecyclePolicy(
    name: string,
    policy: {
      prefix?: string;
      expireAfterDays?: number;
      transitionToColdAfterDays?: number;
    },
  ): Promise<void> {
    const bucket = await this.findOne(name);
    await this.pool.query(
      `INSERT INTO lifecycle_policies
         (bucket_id, prefix, expire_after_days, transition_to_cold_after_days)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (bucket_id) DO UPDATE SET
         prefix = EXCLUDED.prefix,
         expire_after_days = EXCLUDED.expire_after_days,
         transition_to_cold_after_days = EXCLUDED.transition_to_cold_after_days,
         enabled = true`,
      [bucket.id, policy.prefix ?? null, policy.expireAfterDays ?? null, policy.transitionToColdAfterDays ?? null],
    );
  }

  private toModel(row: Record<string, unknown>): Bucket {
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      ownerId: row['owner_id'] as string,
      versioningEnabled: row['versioning_enabled'] as boolean,
      createdAt: row['created_at'] as Date,
      updatedAt: row['updated_at'] as Date,
    };
  }
}

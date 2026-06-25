import { createHash } from 'crypto';
import {
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { DEFAULT_CHUNK_SIZE_BYTES } from '@mini-s3/shared-types';
import { PG_POOL } from '../database/database.module';
import { ChunkService, ChunkRef } from '../storage/chunk.service';

export interface PutResult {
  etag: string;
  sizeBytes: number;
  versionId: string;
}

export interface GetResult {
  data: Buffer;
  etag: string;
  sizeBytes: number;
  contentSha256: string;
  versionId: string;
}

export interface RangeResult {
  data: Buffer;
  etag: string;
  sizeBytes: number;        // full object size
  rangeStart: number;
  rangeEnd: number;
}

export interface VersionInfo {
  versionId: string;
  versionNumber: number;
  sizeBytes: number;
  etag: string;
  isDeleteMarker: boolean;
  createdAt: string;
}

@Injectable()
export class ObjectsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly chunkSvc: ChunkService,
  ) {}

  async put(
    bucketName: string,
    objectKey: string,
    body: Buffer,
  ): Promise<PutResult> {
    const bucketId = await this.resolveBucket(bucketName);

    const chunkBuffers = this.splitChunks(body);
    const chunkRefs = await Promise.all(
      chunkBuffers.map((buf) => this.chunkSvc.writeChunk(buf)),
    );

    const sizeBytes = body.length;
    const contentSha256 =
      chunkRefs.length === 1
        ? chunkRefs[0].sha256
        : createHash('sha256')
            .update(chunkRefs.map((c) => c.sha256).join(''))
            .digest('hex');
    const etag = contentSha256.slice(0, 32);

    const versionId = await this.writeObjectMetadata(
      bucketId,
      objectKey,
      sizeBytes,
      contentSha256,
      etag,
      chunkRefs,
    );

    return { etag, sizeBytes, versionId };
  }

  async get(bucketName: string, objectKey: string, versionId?: string): Promise<GetResult> {
    const rows = await this.fetchManifest(bucketName, objectKey, versionId);

    if (rows.length === 0) {
      throw new NotFoundException(
        `Object "${objectKey}" not found in bucket "${bucketName}"`,
      );
    }

    if (rows[0].is_delete_marker) {
      throw new NotFoundException(
        `Object "${objectKey}" has been deleted`,
      );
    }

    // Phase 3: use chunkSvc.readChunk for replica selection + checksum verification.
    const parts = await Promise.all(
      rows.map((row) => this.chunkSvc.readChunk(row.chunk_sha256)),
    );

    const first = rows[0];
    return {
      data: Buffer.concat(parts),
      etag: first.etag,
      sizeBytes: Number(first.size_bytes),
      contentSha256: first.content_sha256,
      versionId: first.version_id,
    };
  }

  /**
   * Range request — returns only the bytes in [rangeStart, rangeEnd] (inclusive).
   * The manifest's byte_offset column makes the chunk-overlap calculation O(chunks in range).
   */
  async getRange(
    bucketName: string,
    objectKey: string,
    rangeStart: number,
    rangeEnd: number,
  ): Promise<RangeResult> {
    const rows = await this.fetchManifest(bucketName, objectKey);
    if (rows.length === 0) {
      throw new NotFoundException(`Object "${objectKey}" not found in bucket "${bucketName}"`);
    }
    if (rows[0].is_delete_marker) {
      throw new NotFoundException(`Object "${objectKey}" has been deleted`);
    }

    const sizeBytes = Number(rows[0].size_bytes);

    // Clamp range to actual object bounds.
    const clampedStart = Math.max(0, rangeStart);
    const clampedEnd = Math.min(sizeBytes - 1, rangeEnd);

    // Filter to only chunks whose byte range overlaps with the requested range.
    const relevant = rows.filter((r) => {
      const chunkStart = Number(r.byte_offset);
      const chunkEnd = chunkStart + Number(r.chunk_size) - 1;
      return chunkStart <= clampedEnd && chunkEnd >= clampedStart;
    });

    const parts = await Promise.all(
      relevant.map((r) => {
        const chunkStart = Number(r.byte_offset);
        const sliceStart = Math.max(0, clampedStart - chunkStart);
        const sliceEnd = Math.min(Number(r.chunk_size) - 1, clampedEnd - chunkStart);
        return this.chunkSvc.readChunkRange(r.chunk_sha256, sliceStart, sliceEnd);
      }),
    );

    return {
      data: Buffer.concat(parts),
      etag: rows[0].etag,
      sizeBytes,
      rangeStart: clampedStart,
      rangeEnd: clampedEnd,
    };
  }

  /** Insert a delete marker as a new version. GET on a delete marker returns 404. */
  async deleteObject(bucketName: string, objectKey: string): Promise<void> {
    const bucketId = await this.resolveBucket(bucketName);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const objRes = await client.query<{ id: string; versioning_enabled: boolean }>(
        `SELECT o.id, b.versioning_enabled
         FROM objects o JOIN buckets b ON b.id = o.bucket_id
         WHERE b.name = $1 AND o.object_key = $2`,
        [bucketName, objectKey],
      );

      if (objRes.rows.length === 0) {
        throw new NotFoundException(`Object "${objectKey}" not found in bucket "${bucketName}"`);
      }

      const { id: objectId } = objRes.rows[0];

      const versionRes = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next
         FROM object_versions WHERE object_id = $1`,
        [objectId],
      );
      const versionNumber = versionRes.rows[0].next;

      const versionInsert = await client.query<{ id: string }>(
        `INSERT INTO object_versions
           (object_id, version_number, size_bytes, content_sha256, etag, is_delete_marker)
         VALUES ($1, $2, 0, NULL, 'deleted', true)
         RETURNING id`,
        [objectId, versionNumber],
      );
      const versionId = versionInsert.rows[0].id;

      await client.query(
        `UPDATE objects SET latest_version_id = $1, is_deleted = true, updated_at = now()
         WHERE id = $2`,
        [versionId, objectId],
      );

      // Update bucket stats: subtract the deleted object's size.
      await client.query(
        `UPDATE bucket_stats bs SET
           total_objects = GREATEST(0, total_objects - 1),
           updated_at = now()
         WHERE bucket_id = $1`,
        [bucketId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** List all versions of an object key (for ?versions query param). */
  async listVersions(bucketName: string, objectKey: string): Promise<VersionInfo[]> {
    const res = await this.pool.query<{
      id: string;
      version_number: string;
      size_bytes: string;
      etag: string;
      is_delete_marker: boolean;
      created_at: string;
    }>(
      `SELECT ov.id, ov.version_number, ov.size_bytes, ov.etag,
              ov.is_delete_marker, ov.created_at
       FROM object_versions ov
       JOIN objects o ON o.id = ov.object_id
       JOIN buckets b ON b.id = o.bucket_id
       WHERE b.name = $1 AND o.object_key = $2
       ORDER BY ov.version_number DESC`,
      [bucketName, objectKey],
    );
    return res.rows.map((r) => ({
      versionId: r.id,
      versionNumber: Number(r.version_number),
      sizeBytes: Number(r.size_bytes),
      etag: r.etag,
      isDeleteMarker: r.is_delete_marker,
      createdAt: r.created_at,
    }));
  }

  /**
   * Restore an old version by making it the latest.
   * No bytes move — the manifest rows are re-pointed and ref_counts bumped.
   * This is the same technique S3 uses for version restore.
   */
  async restoreVersion(
    bucketName: string,
    objectKey: string,
    targetVersionId: string,
  ): Promise<PutResult> {
    // Fetch target version's chunks.
    const chunkRes = await this.pool.query<{
      chunk_id: string;
      content_sha256: string;
      size_bytes: string;
      chunk_index: number;
      byte_offset: string;
    }>(
      `SELECT ovc.chunk_id, c.content_sha256, c.size_bytes, ovc.chunk_index, ovc.byte_offset
       FROM object_version_chunks ovc
       JOIN chunks c ON c.id = ovc.chunk_id
       WHERE ovc.object_version_id = $1
       ORDER BY ovc.chunk_index`,
      [targetVersionId],
    );

    const versionRow = await this.pool.query<{
      size_bytes: string;
      content_sha256: string;
      etag: string;
      object_id: string;
    }>(
      `SELECT ov.size_bytes, ov.content_sha256, ov.etag, ov.object_id
       FROM object_versions ov
       JOIN objects o ON o.id = ov.object_id
       JOIN buckets b ON b.id = o.bucket_id
       WHERE ov.id = $1 AND b.name = $2 AND o.object_key = $3`,
      [targetVersionId, bucketName, objectKey],
    );

    if (versionRow.rows.length === 0) {
      throw new NotFoundException(`Version ${targetVersionId} not found`);
    }

    const { size_bytes, content_sha256, etag } = versionRow.rows[0];
    const chunkRefs: ChunkRef[] = chunkRes.rows.map((r) => ({
      id: r.chunk_id,
      sha256: r.content_sha256,
      sizeBytes: Number(r.size_bytes),
    }));

    const bucketId = await this.resolveBucket(bucketName);
    const newVersionId = await this.writeObjectMetadata(
      bucketId,
      objectKey,
      Number(size_bytes),
      content_sha256,
      etag,
      chunkRefs,
    );

    return { etag, sizeBytes: Number(size_bytes), versionId: newVersionId };
  }

  // ── Called by MultipartService.complete() ────────────────────────────────

  async writeObjectMetadata(
    bucketId: string,
    objectKey: string,
    sizeBytes: number,
    contentSha256: string,
    etag: string,
    chunkRefs: ChunkRef[],
  ): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const objectRes = await client.query<{ id: string }>(
        `INSERT INTO objects (bucket_id, object_key)
         VALUES ($1, $2)
         ON CONFLICT (bucket_id, object_key) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [bucketId, objectKey],
      );
      const objectId = objectRes.rows[0].id;

      const versionRes = await client.query<{ next: string }>(
        `SELECT COALESCE(MAX(version_number), 0) + 1 AS next
         FROM object_versions WHERE object_id = $1`,
        [objectId],
      );
      const versionNumber = versionRes.rows[0].next;

      const versionInsert = await client.query<{ id: string }>(
        `INSERT INTO object_versions
           (object_id, version_number, size_bytes, content_sha256, etag)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [objectId, versionNumber, sizeBytes, contentSha256, etag],
      );
      const versionId = versionInsert.rows[0].id;

      let byteOffset = 0;
      for (let i = 0; i < chunkRefs.length; i++) {
        await client.query(
          `INSERT INTO object_version_chunks
             (object_version_id, chunk_id, chunk_index, byte_offset)
           VALUES ($1, $2, $3, $4)`,
          [versionId, chunkRefs[i].id, i, byteOffset],
        );
        await client.query(
          `UPDATE chunks SET ref_count = ref_count + 1 WHERE id = $1`,
          [chunkRefs[i].id],
        );
        byteOffset += chunkRefs[i].sizeBytes;
      }

      await client.query(
        `UPDATE objects
         SET latest_version_id = $1, is_deleted = false, updated_at = now()
         WHERE id = $2`,
        [versionId, objectId],
      );

      await client.query(
        `INSERT INTO bucket_stats (bucket_id, total_objects, total_bytes)
         VALUES ($1, 1, $2)
         ON CONFLICT (bucket_id) DO UPDATE SET
           total_objects = bucket_stats.total_objects + 1,
           total_bytes   = bucket_stats.total_bytes + $2,
           updated_at    = now()`,
        [bucketId, sizeBytes],
      );

      await client.query('COMMIT');
      return versionId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async resolveBucket(bucketName: string): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `SELECT id FROM buckets WHERE name = $1`,
      [bucketName],
    );
    if (res.rows.length === 0) {
      throw new NotFoundException(`Bucket "${bucketName}" not found`);
    }
    return res.rows[0].id;
  }

  private async fetchManifest(
    bucketName: string,
    objectKey: string,
    versionId?: string,
  ) {
    const base = `
      SELECT
        ov.id AS version_id,
        ov.size_bytes,
        ov.content_sha256,
        ov.etag,
        ov.is_delete_marker,
        c.content_sha256 AS chunk_sha256,
        c.size_bytes AS chunk_size,
        ovc.byte_offset
      FROM buckets b
      JOIN objects o          ON o.bucket_id = b.id
      JOIN object_versions ov ON ov.id = ${versionId ? '$3' : 'o.latest_version_id'}
      LEFT JOIN object_version_chunks ovc ON ovc.object_version_id = ov.id
      LEFT JOIN chunks c ON c.id = ovc.chunk_id
      WHERE b.name = $1
        AND o.object_key = $2
        AND o.is_deleted = false
      ORDER BY ovc.chunk_index`;

    const params: (string | undefined)[] = [bucketName, objectKey];
    if (versionId) params.push(versionId);

    const res = await this.pool.query<{
      version_id: string;
      size_bytes: string;
      content_sha256: string;
      etag: string;
      is_delete_marker: boolean;
      chunk_sha256: string;
      chunk_size: string;
      byte_offset: string;
    }>(base, params);

    return res.rows;
  }

  private splitChunks(body: Buffer): Buffer[] {
    if (body.length === 0) return [Buffer.alloc(0)];
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < body.length; offset += DEFAULT_CHUNK_SIZE_BYTES) {
      chunks.push(body.subarray(offset, offset + DEFAULT_CHUNK_SIZE_BYTES));
    }
    return chunks;
  }

  /** Parse a Range header value like "bytes=0-1023". Returns null if invalid. */
  static parseRange(
    rangeHeader: string,
    totalSize: number,
  ): { start: number; end: number } | null {
    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : totalSize - 1;
    if (start > end || start >= totalSize) return null;
    return { start, end: Math.min(end, totalSize - 1) };
  }
}

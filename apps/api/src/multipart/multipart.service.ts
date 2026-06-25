import { createHash } from 'crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { ChunkService } from '../storage/chunk.service';
import { ObjectsService } from '../objects/objects.service';

export interface PartInput {
  partNumber: number;
  etag: string;
}

@Injectable()
export class MultipartService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly chunkSvc: ChunkService,
    private readonly objectsSvc: ObjectsService,
  ) {}

  async initiate(
    bucketName: string,
    objectKey: string,
  ): Promise<{ uploadId: string }> {
    const bucketId = await this.objectsSvc.resolveBucket(bucketName);

    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO multipart_uploads (bucket_id, object_key)
       VALUES ($1, $2)
       RETURNING id`,
      [bucketId, objectKey],
    );
    return { uploadId: res.rows[0].id };
  }

  async uploadPart(
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<{ etag: string; partNumber: number }> {
    // Verify the upload session is still active.
    const upload = await this.pool.query<{ id: string }>(
      `SELECT id FROM multipart_uploads WHERE id = $1 AND status = 'in_progress'`,
      [uploadId],
    );
    if (upload.rows.length === 0) {
      throw new NotFoundException(
        `Multipart upload "${uploadId}" not found or already completed/aborted`,
      );
    }

    const chunk = await this.chunkSvc.writeChunk(body);
    // ETag for a part = first 32 chars of SHA-256 of the part body.
    const etag = chunk.sha256.slice(0, 32);

    await this.pool.query(
      `INSERT INTO multipart_parts
         (upload_id, part_number, chunk_id, etag, size_bytes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (upload_id, part_number) DO UPDATE
         SET chunk_id = EXCLUDED.chunk_id,
             etag = EXCLUDED.etag,
             size_bytes = EXCLUDED.size_bytes`,
      [uploadId, partNumber, chunk.id, etag, chunk.sizeBytes],
    );

    return { etag, partNumber };
  }

  async complete(
    _bucketName: string,
    objectKey: string,
    uploadId: string,
    parts: PartInput[],
  ): Promise<{ etag: string; sizeBytes: number }> {
    // Load the upload row + all stored parts in one query.
    const uploadRes = await this.pool.query<{
      upload_id: string;
      bucket_id: string;
      object_key: string;
      part_number: number;
      chunk_id: string;
      chunk_sha256: string;
      chunk_size: number;
      stored_etag: string;
    }>(
      `SELECT
         mu.id AS upload_id,
         mu.bucket_id,
         mu.object_key,
         mp.part_number,
         mp.chunk_id,
         c.content_sha256 AS chunk_sha256,
         c.size_bytes AS chunk_size,
         mp.etag AS stored_etag
       FROM multipart_uploads mu
       JOIN multipart_parts mp ON mp.upload_id = mu.id
       JOIN chunks c ON c.id = mp.chunk_id
       WHERE mu.id = $1
         AND mu.status = 'in_progress'
       ORDER BY mp.part_number`,
      [uploadId],
    );

    if (uploadRes.rows.length === 0) {
      throw new NotFoundException(
        `Multipart upload "${uploadId}" not found or already completed/aborted`,
      );
    }

    // Validate: client-provided parts must match stored ETags and cover all parts.
    const storedByPart = new Map(
      uploadRes.rows.map((r) => [r.part_number, r]),
    );
    const sortedInput = [...parts].sort((a, b) => a.partNumber - b.partNumber);

    for (const p of sortedInput) {
      const stored = storedByPart.get(p.partNumber);
      if (!stored) {
        throw new BadRequestException(
          `Part ${p.partNumber} was not uploaded`,
        );
      }
      if (stored.stored_etag !== p.etag) {
        throw new BadRequestException(
          `Part ${p.partNumber} ETag mismatch: expected "${stored.stored_etag}", got "${p.etag}"`,
        );
      }
    }

    // Build the ordered chunk list from the client-specified part order.
    const orderedChunks = sortedInput.map((p) => {
      const row = storedByPart.get(p.partNumber)!;
      return {
        id: row.chunk_id,
        sha256: row.chunk_sha256,
        sizeBytes: Number(row.chunk_size),
      };
    });

    const sizeBytes = orderedChunks.reduce((sum, c) => sum + c.sizeBytes, 0);

    // Final ETag = SHA-256 of all part ETags concatenated, first 32 chars.
    const contentSha256 = createHash('sha256')
      .update(sortedInput.map((p) => p.etag).join(''))
      .digest('hex');
    const etag = contentSha256.slice(0, 32);

    const bucketId = uploadRes.rows[0].bucket_id;

    // Assemble the final object manifest — no physical data movement needed.
    await this.objectsSvc.writeObjectMetadata(
      bucketId,
      objectKey,
      sizeBytes,
      contentSha256,
      etag,
      orderedChunks,
    );

    // Mark the upload complete.
    await this.pool.query(
      `UPDATE multipart_uploads SET status = 'completed' WHERE id = $1`,
      [uploadId],
    );

    return { etag, sizeBytes };
  }

  async abort(uploadId: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE multipart_uploads
       SET status = 'aborted'
       WHERE id = $1 AND status = 'in_progress'
       RETURNING id`,
      [uploadId],
    );
    if (res.rowCount === 0) {
      throw new NotFoundException(
        `Multipart upload "${uploadId}" not found or already completed/aborted`,
      );
    }
    // Part chunks have ref_count = 0 (not yet referenced by any manifest).
    // The GC worker (Phase 4) reclaims them during its next sweep.
  }
}

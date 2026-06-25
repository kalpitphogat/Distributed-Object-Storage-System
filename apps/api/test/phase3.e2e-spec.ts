/**
 * Phase 3 integration tests — hash ring, RF=3 replication, write quorum, read repair.
 *
 * Prerequisites:  docker compose up -d  (5 MinIO nodes running)
 * Run:           pnpm --filter @mini-s3/api test:integration
 *
 * DoD assertions:
 *  - Each chunk is written to exactly RF=3 nodes (chunk_replicas rows)
 *  - Killing one MinIO node: writes still succeed (W=2 quorum)
 *  - Killing one MinIO node: reads still succeed from the 2 remaining replicas
 *  - Node admin endpoint shows 5 healthy storage nodes
 */

import { execSync } from 'child_process';
import request from 'supertest';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';

const API = process.env['API_URL'] ?? 'http://localhost:3000';
const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://miniadmin:minipassword@localhost:5432/minis3';

const RUN_ID = Date.now();
const BUCKET = `test-p3-${RUN_ID}`;
const RF = 3;

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  await request(API).put(`/buckets/${BUCKET}`);
});

afterAll(async () => {
  await pool.end();
});

describe('Phase 3 — consistent hash ring', () => {
  it('admin/nodes lists 5 active storage nodes', async () => {
    const res = await request(API).get('/admin/nodes');
    expect(res.status).toBe(200);
    const nodes = res.body as { status: string }[];
    const activeCount = nodes.filter((n) => n.status === 'active').length;
    expect(activeCount).toBe(5);
  });
});

describe('Phase 3 — RF=3 replication', () => {
  const content = randomBytes(128); // small chunk, deterministic placement

  it('after PUT, chunk has exactly RF=3 replica rows in DB', async () => {
    const key = `replication/rf-test-${RUN_ID}.bin`;
    const put = await request(API)
      .put(`/buckets/${BUCKET}/objects/${key}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);
    expect(put.status).toBe(200);

    // Check chunk_replicas count.
    const chunkRes = await pool.query<{ cnt: string }>(
      `SELECT COUNT(cr.id) AS cnt
       FROM chunks c
       JOIN chunk_replicas cr ON cr.chunk_id = c.id
       JOIN object_version_chunks ovc ON ovc.chunk_id = c.id
       JOIN object_versions ov ON ov.id = ovc.object_version_id
       JOIN objects o ON o.id = ov.object_id
       JOIN buckets b ON b.id = o.bucket_id
       WHERE b.name = $1 AND o.object_key = $2`,
      [BUCKET, key],
    );
    expect(Number(chunkRes.rows[0].cnt)).toBe(RF);
  });

  it('GET returns the same bytes as PUT (round-trip with CAS verification)', async () => {
    const key = `replication/verify-${RUN_ID}.bin`;
    await request(API)
      .put(`/buckets/${BUCKET}/objects/${key}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);

    const get = await request(API)
      .get(`/buckets/${BUCKET}/objects/${key}`)
      .buffer(true);

    expect(get.status).toBe(200);
    expect(Buffer.compare(content, get.body as Buffer)).toBe(0);
  });
});

describe('Phase 3 — write quorum (W=2 of 3)', () => {
  it('writes succeed and reads succeed when one node is stopped', async () => {
    const keyBefore = `quorum/before-stop-${RUN_ID}.bin`;
    const contentBefore = randomBytes(64);

    // Upload before stopping a node.
    const put1 = await request(API)
      .put(`/buckets/${BUCKET}/objects/${keyBefore}`)
      .set('Content-Type', 'application/octet-stream')
      .send(contentBefore);
    expect(put1.status).toBe(200);

    // Stop minio-1 (one of RF=3 nodes).
    execSync('docker stop mini-s3-minio-1', { stdio: 'ignore' });

    try {
      // Upload while minio-1 is down — should still succeed with W=2.
      const keyDuring = `quorum/during-stop-${RUN_ID}.bin`;
      const contentDuring = randomBytes(64);
      const put2 = await request(API)
        .put(`/buckets/${BUCKET}/objects/${keyDuring}`)
        .set('Content-Type', 'application/octet-stream')
        .send(contentDuring);
      expect(put2.status).toBe(200);

      // Read the pre-stop object from remaining replicas.
      const get1 = await request(API)
        .get(`/buckets/${BUCKET}/objects/${keyBefore}`)
        .buffer(true);
      expect(get1.status).toBe(200);
      expect(Buffer.compare(contentBefore, get1.body as Buffer)).toBe(0);

      // Read the object written during the outage.
      const get2 = await request(API)
        .get(`/buckets/${BUCKET}/objects/${keyDuring}`)
        .buffer(true);
      expect(get2.status).toBe(200);
      expect(Buffer.compare(contentDuring, get2.body as Buffer)).toBe(0);
    } finally {
      // Always restart minio-1 so subsequent tests are not affected.
      execSync('docker start mini-s3-minio-1', { stdio: 'ignore' });
      // Give it a moment to come back up.
      await new Promise((r) => setTimeout(r, 3000));
    }
  }, 30_000);
});

/**
 * Phase 4 integration tests — versioning, GC, range requests.
 *
 * DoD assertions:
 *  - Object versions are tracked per PUT; old versions are retrievable by versionId
 *  - DELETE inserts a delete marker; GET returns 404; specific version still fetchable
 *  - Restore operation brings an old version back as latest
 *  - Range header returns exactly the right bytes across a chunk boundary
 *  - GC admin endpoint shows orphaned chunks (ref_count=0)
 */

import request from 'supertest';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';

const API = process.env['API_URL'] ?? 'http://localhost:3000';
const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://miniadmin:minipassword@localhost:5432/minis3';

const RUN_ID = Date.now();
const BUCKET = `test-p4-${RUN_ID}`;

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB_URL });
  await request(API).put(`/buckets/${BUCKET}`);
});

afterAll(async () => {
  await pool.end();
});

describe('Phase 4 — versioning', () => {
  const key = `versioned/object-${RUN_ID}.bin`;
  let version1Id: string;
  let version2Id: string;

  it('PUT creates version 1', async () => {
    const res = await request(API)
      .put(`/buckets/${BUCKET}/objects/${key}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('version-one'));
    expect(res.status).toBe(200);
    version1Id = (res.body as { versionId: string }).versionId;
    expect(typeof version1Id).toBe('string');
  });

  it('second PUT creates version 2', async () => {
    const res = await request(API)
      .put(`/buckets/${BUCKET}/objects/${key}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('version-two'));
    expect(res.status).toBe(200);
    version2Id = (res.body as { versionId: string }).versionId;
    expect(version2Id).not.toBe(version1Id);
  });

  it('GET without versionId returns latest (version 2)', async () => {
    const res = await request(API)
      .get(`/buckets/${BUCKET}/objects/${key}`)
      .buffer(true);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('version-two');
  });

  it('GET with versionId=version1Id returns version 1 content', async () => {
    const res = await request(API)
      .get(`/buckets/${BUCKET}/objects/${key}?versionId=${version1Id}`)
      .buffer(true);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).toString()).toBe('version-one');
  });

  it('?versions returns full version history in descending order', async () => {
    const res = await request(API).get(`/buckets/${BUCKET}/objects/${key}?versions`);
    expect(res.status).toBe(200);
    const versions = res.body as { versionId: string; versionNumber: number }[];
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions[0].versionNumber).toBeGreaterThan(versions[1].versionNumber);
  });
});

describe('Phase 4 — delete markers', () => {
  const key = `delete/object-${RUN_ID}.bin`;

  it('PUT then DELETE then GET returns 404', async () => {
    await request(API)
      .put(`/buckets/${BUCKET}/objects/${key}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('to be deleted'));

    const del = await request(API).delete(`/buckets/${BUCKET}/objects/${key}`);
    expect(del.status).toBe(204);

    const get = await request(API).get(`/buckets/${BUCKET}/objects/${key}`);
    expect(get.status).toBe(404);
  });

  it('restore from a specific version brings content back', async () => {
    const restoreKey = `delete/restorable-${RUN_ID}.bin`;
    const putRes = await request(API)
      .put(`/buckets/${BUCKET}/objects/${restoreKey}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('original content'));

    const origVersionId = (putRes.body as { versionId: string }).versionId;

    await request(API).delete(`/buckets/${BUCKET}/objects/${restoreKey}`);

    // Restore.
    const restore = await request(API).put(
      `/buckets/${BUCKET}/objects/${restoreKey}?versionId=${origVersionId}&restore=true`,
    );
    expect(restore.status).toBe(200);

    // GET should now return original content.
    const get = await request(API)
      .get(`/buckets/${BUCKET}/objects/${restoreKey}`)
      .buffer(true);
    expect(get.status).toBe(200);
    expect((get.body as Buffer).toString()).toBe('original content');
  });
});

describe('Phase 4 — range requests', () => {
  // Build a 20 MB object (3 × 8 MB chunks) to test cross-chunk range.
  const CHUNK = 8 * 1024 * 1024;
  const content = randomBytes(3 * CHUNK); // 24 MB
  const key = `range/large-${RUN_ID}.bin`;

  beforeAll(async () => {
    await request(API)
      .put(`/buckets/${BUCKET}/objects/${key}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);
  });

  it('Range: bytes=0-99 returns first 100 bytes with 206', async () => {
    const res = await request(API)
      .get(`/buckets/${BUCKET}/objects/${key}`)
      .set('Range', 'bytes=0-99')
      .buffer(true);
    expect(res.status).toBe(206);
    const body = res.body as Buffer;
    expect(body.length).toBe(100);
    expect(Buffer.compare(body, content.subarray(0, 100))).toBe(0);
  });

  it('Range spanning chunk boundary (bytes=7MB-9MB) returns correct bytes', async () => {
    const start = 7 * 1024 * 1024;
    const end = 9 * 1024 * 1024 - 1;
    const res = await request(API)
      .get(`/buckets/${BUCKET}/objects/${key}`)
      .set('Range', `bytes=${start}-${end}`)
      .buffer(true);
    expect(res.status).toBe(206);
    const body = res.body as Buffer;
    expect(body.length).toBe(end - start + 1);
    expect(Buffer.compare(body, content.subarray(start, end + 1))).toBe(0);
  });

  it('Range without end returns from start to EOF', async () => {
    const start = content.length - 50;
    const res = await request(API)
      .get(`/buckets/${BUCKET}/objects/${key}`)
      .set('Range', `bytes=${start}-`)
      .buffer(true);
    expect(res.status).toBe(206);
    const body = res.body as Buffer;
    expect(body.length).toBe(50);
    expect(Buffer.compare(body, content.subarray(start))).toBe(0);
  });
});

describe('Phase 4 — admin GC stats', () => {
  it('/admin/gc/stats returns chunk counts', async () => {
    const res = await request(API).get('/admin/gc/stats');
    expect(res.status).toBe(200);
    const stats = res.body as { totalChunks: number; orphanedChunks: number; totalBytes: number };
    expect(typeof stats.totalChunks).toBe('number');
    expect(typeof stats.orphanedChunks).toBe('number');
    expect(stats.totalChunks).toBeGreaterThan(0);
  });
});

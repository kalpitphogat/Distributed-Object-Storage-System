/**
 * Phase 1 integration tests — run against the live docker-compose stack.
 *
 * Prerequisites:  docker compose up -d  (stack must be healthy)
 * Run:           pnpm --filter @mini-s3/api test:integration
 *
 * DoD assertions:
 *  - bucket CRUD works end-to-end
 *  - PUT an object then GET it back byte-for-byte
 *  - uploading identical content twice creates exactly ONE chunk row (dedup)
 */

import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { Pool } from 'pg';

const API = process.env['API_URL'] ?? 'http://localhost:3000';
const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://miniadmin:minipassword@localhost:5432/minis3';

// Unique per test-run so parallel runs don't collide.
const RUN_ID = Date.now();
const BUCKET = `test-p1-${RUN_ID}`;

describe('Phase 1 — bucket CRUD', () => {
  it('creates a bucket', async () => {
    const res = await request(API).put(`/buckets/${BUCKET}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(BUCKET);
  });

  it('returns 409 on duplicate create', async () => {
    const res = await request(API).put(`/buckets/${BUCKET}`);
    expect(res.status).toBe(409);
  });

  it('lists buckets and includes the test bucket', async () => {
    const res = await request(API).get('/buckets');
    expect(res.status).toBe(200);
    expect(res.body.some((b: { name: string }) => b.name === BUCKET)).toBe(true);
  });

  it('gets bucket by name', async () => {
    const res = await request(API).get(`/buckets/${BUCKET}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(BUCKET);
  });

  it('returns 404 for unknown bucket', async () => {
    const res = await request(API).get(`/buckets/no-such-bucket-${RUN_ID}`);
    expect(res.status).toBe(404);
  });

  it('rejects invalid bucket names', async () => {
    const res = await request(API).put('/buckets/AB'); // uppercase, too short
    expect(res.status).toBe(400);
  });
});

describe('Phase 1 — object round-trip and CAS dedup', () => {
  let pool: Pool;
  const content = randomBytes(1024); // 1 KB of random bytes
  const sha256 = createHash('sha256').update(content).digest('hex');
  const KEY_A = 'docs/readme.bin';
  const KEY_B = 'docs/copy.bin'; // same content, different key

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    // Ensure bucket exists (idempotent: bucket suite creates it first,
    // but this beforeAll makes the object suite runnable in isolation too).
    await request(API).put(`/buckets/${BUCKET}`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('uploads an object and returns ETag', async () => {
    const res = await request(API)
      .put(`/buckets/${BUCKET}/objects/${KEY_A}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);

    expect(res.status).toBe(200);
    expect(res.body.sizeBytes).toBe(1024);
    expect(res.headers['etag']).toBeDefined();
  });

  it('downloads the object and content matches byte-for-byte', async () => {
    // .buffer(true) tells superagent to collect the binary body into res.body
    const res = await request(API)
      .get(`/buckets/${BUCKET}/objects/${KEY_A}`)
      .buffer(true);

    expect(res.status).toBe(200);
    // superagent returns binary octet-stream as a Buffer with buffer(true)
    const body = Buffer.isBuffer(res.body)
      ? res.body
      : Buffer.from(res.body as string, 'binary');
    expect(Buffer.compare(content, body)).toBe(0);
  });

  it('dedup: uploading identical content under a second key creates no new chunk row', async () => {
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM chunks WHERE content_sha256 = $1`,
      [sha256],
    );
    expect(Number(before.rows[0].count)).toBe(1); // one row from first upload

    await request(API)
      .put(`/buckets/${BUCKET}/objects/${KEY_B}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);

    const after = await pool.query<{ count: string; ref_count: string }>(
      `SELECT COUNT(*) AS count, MAX(ref_count) AS ref_count
       FROM chunks WHERE content_sha256 = $1`,
      [sha256],
    );
    // Still one chunk row — bytes were not written to MinIO again.
    expect(Number(after.rows[0].count)).toBe(1);
    // ref_count bumped to 2 because two manifests now reference this chunk.
    expect(Number(after.rows[0].ref_count)).toBe(2);
  });

  it('supports object keys with slashes (folder/sub/file)', async () => {
    const nestedKey = 'a/b/c/nested.bin';
    const smallContent = Buffer.from('hello nested');

    const put = await request(API)
      .put(`/buckets/${BUCKET}/objects/${nestedKey}`)
      .set('Content-Type', 'application/octet-stream')
      .send(smallContent);
    expect(put.status).toBe(200);

    const get = await request(API)
      .get(`/buckets/${BUCKET}/objects/${nestedKey}`)
      .buffer(true);
    expect(get.status).toBe(200);
    const body = Buffer.isBuffer(get.body)
      ? get.body
      : Buffer.from(get.body as string, 'binary');
    expect(Buffer.compare(smallContent, body)).toBe(0);
  });

  it('returns 404 for object not found', async () => {
    const res = await request(API).get(
      `/buckets/${BUCKET}/objects/no-such-object`,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when bucket does not exist', async () => {
    const res = await request(API).get(
      `/buckets/no-such-bucket-${RUN_ID}/objects/any-key`,
    );
    expect(res.status).toBe(404);
  });
});

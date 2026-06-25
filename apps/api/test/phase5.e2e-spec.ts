/**
 * Phase 5 integration tests — authentication, presigned URLs, bucket config.
 *
 * DoD assertions:
 *  - POST /auth/keys creates an access key and returns raw secret once
 *  - GET /presign returns a signed URL; fetching it returns the object bytes
 *  - Expired presigned URLs return 403
 *  - PUT /buckets/:name/versioning enables versioning flag
 *  - PUT /buckets/:name/lifecycle stores a lifecycle policy
 */

import request from 'supertest';
import { randomBytes } from 'crypto';

const API = process.env['API_URL'] ?? 'http://localhost:3000';

const RUN_ID = Date.now();
const BUCKET = `test-p5-${RUN_ID}`;
const OBJECT_KEY = `auth/test-${RUN_ID}.bin`;
const CONTENT = randomBytes(64);

let accessKeyId: string;
let rawSecret: string;

beforeAll(async () => {
  await request(API).put(`/buckets/${BUCKET}`);
  // Upload an object so the presigned URL has something to fetch.
  await request(API)
    .put(`/buckets/${BUCKET}/objects/${OBJECT_KEY}`)
    .set('Content-Type', 'application/octet-stream')
    .send(CONTENT);
});

describe('Phase 5 — access key creation', () => {
  it('POST /auth/keys returns accessKeyId and rawSecret', async () => {
    const res = await request(API)
      .post('/auth/keys')
      .set('Content-Type', 'application/json')
      .send({ ownerId: '00000000-0000-0000-0000-000000000001' });
    expect(res.status).toBe(201);
    const body = res.body as { accessKeyId: string; rawSecret: string };
    expect(typeof body.accessKeyId).toBe('string');
    expect(typeof body.rawSecret).toBe('string');
    expect(body.accessKeyId.length).toBeGreaterThan(8);
    expect(body.rawSecret.length).toBeGreaterThan(16);
    accessKeyId = body.accessKeyId;
    rawSecret = body.rawSecret;
  });
});

describe('Phase 5 — presigned URLs', () => {
  it('presigned GET URL returns the object bytes', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 min from now
    const presignRes = await request(API)
      .get('/presign')
      .query({
        method: 'GET',
        bucket: BUCKET,
        key: OBJECT_KEY,
        expires: expiresAt,
        accessKeyId,
        secret: rawSecret,
      });
    expect(presignRes.status).toBe(200);
    const { url } = presignRes.body as { url: string };
    expect(typeof url).toBe('string');
    expect(url).toContain('Signature=');

    // Fetch the presigned URL directly.
    const getRes = await request(API)
      .get(url.replace(/^https?:\/\/[^/]+/, ''))
      .buffer(true);
    expect(getRes.status).toBe(200);
    expect(Buffer.compare(CONTENT, getRes.body as Buffer)).toBe(0);
  });

  it('expired presigned URL returns 403', async () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 1; // already expired
    const presignRes = await request(API)
      .get('/presign')
      .query({
        method: 'GET',
        bucket: BUCKET,
        key: OBJECT_KEY,
        expires: expiredAt,
        accessKeyId,
        secret: rawSecret,
      });
    expect(presignRes.status).toBe(200);
    const { url } = presignRes.body as { url: string };
    const path = url.replace(/^https?:\/\/[^/]+/, '');

    const getRes = await request(API).get(path).buffer(true);
    expect(getRes.status).toBe(403);
  });

  it('tampered signature returns 403', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const presignRes = await request(API)
      .get('/presign')
      .query({
        method: 'GET',
        bucket: BUCKET,
        key: OBJECT_KEY,
        expires: expiresAt,
        accessKeyId,
        secret: rawSecret,
      });
    const { url } = presignRes.body as { url: string };
    const tampered = url.replace(/Signature=[^&]+/, 'Signature=deadbeef');
    const path = tampered.replace(/^https?:\/\/[^/]+/, '');
    const getRes = await request(API).get(path).buffer(true);
    expect(getRes.status).toBe(403);
  });
});

describe('Phase 5 — bucket versioning config', () => {
  it('PUT /buckets/:name/versioning enables versioning', async () => {
    const res = await request(API)
      .put(`/buckets/${BUCKET}/versioning`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ enabled: true }));
    expect([200, 204]).toContain(res.status);
  });
});

describe('Phase 5 — lifecycle policy', () => {
  it('PUT /buckets/:name/lifecycle stores policy', async () => {
    const res = await request(API)
      .put(`/buckets/${BUCKET}/lifecycle`)
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          prefix: 'logs/',
          expireAfterDays: 30,
          transitionToColdAfterDays: 7,
        }),
      );
    expect([200, 204]).toContain(res.status);
  });
});

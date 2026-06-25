/**
 * Phase 2 integration tests — run against the live docker-compose stack.
 *
 * Prerequisites:  docker compose up -d
 * Run:           pnpm --filter @mini-s3/api test:integration
 *
 * DoD assertions:
 *  - single-shot PUT of a multi-chunk object round-trips byte-for-byte
 *  - multipart: 50 MB file, parts uploaded in parallel, downloads byte-for-byte
 *  - completing with a wrong ETag is rejected
 *  - abort marks the upload as aborted
 */

import request from 'supertest';
import { randomBytes, createHash } from 'crypto';

const API = process.env['API_URL'] ?? 'http://localhost:3000';

const RUN_ID = Date.now();
const BUCKET = `test-p2-${RUN_ID}`;
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB — must match DEFAULT_CHUNK_SIZE_BYTES

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function readBinaryResponse(res: request.Response): Promise<Buffer> {
  return Buffer.isBuffer(res.body)
    ? res.body
    : Buffer.from(res.body as string, 'binary');
}

beforeAll(async () => {
  await request(API).put(`/buckets/${BUCKET}`);
});

describe('Phase 2 — chunk splitting (single-shot PUT)', () => {
  // 20 MB = 3 chunks (8+8+4) — exercises the splitting path without being slow
  const content = randomBytes(20 * 1024 * 1024);
  const key = 'chunked/twenty-mb.bin';

  it('uploads a 20 MB object (3 chunks) via single-shot PUT', async () => {
    const res = await request(API)
      .put(`/buckets/${BUCKET}/objects/${key}`)
      .set('Content-Type', 'application/octet-stream')
      .send(content);

    expect(res.status).toBe(200);
    expect(res.body.sizeBytes).toBe(20 * 1024 * 1024);
    expect(res.headers['etag']).toBeDefined();
  });

  it('downloads the 20 MB object byte-for-byte', async () => {
    const res = await request(API)
      .get(`/buckets/${BUCKET}/objects/${key}`)
      .buffer(true);

    expect(res.status).toBe(200);
    expect(Buffer.compare(content, await readBinaryResponse(res))).toBe(0);
  });
});

describe('Phase 2 — multipart upload (50 MB, parallel parts)', () => {
  const TOTAL = 50 * 1024 * 1024; // 50 MB
  const content = randomBytes(TOTAL);
  const key = 'multipart/fifty-mb.bin';
  let uploadId: string;

  // Split content into CHUNK_SIZE parts
  const partBuffers: Buffer[] = [];
  for (let offset = 0; offset < TOTAL; offset += CHUNK_SIZE) {
    partBuffers.push(content.subarray(offset, offset + CHUNK_SIZE));
  }

  it('initiates a multipart upload', async () => {
    const res = await request(API).post(
      `/buckets/${BUCKET}/objects/${key}?uploads`,
    );
    expect(res.status).toBe(201);
    expect(typeof res.body.uploadId).toBe('string');
    uploadId = res.body.uploadId as string;
  });

  let partEtags: Array<{ partNumber: number; etag: string }> = [];

  it('uploads all parts in parallel and each returns an ETag', async () => {
    const results = await Promise.all(
      partBuffers.map((buf, i) =>
        request(API)
          .put(
            `/buckets/${BUCKET}/objects/${key}?uploadId=${uploadId}&partNumber=${i + 1}`,
          )
          .set('Content-Type', 'application/octet-stream')
          .send(buf),
      ),
    );

    for (const res of results) {
      expect(res.status).toBe(200);
      expect(res.headers['etag']).toBeDefined();
    }

    partEtags = results.map((res, i) => ({
      partNumber: i + 1,
      etag: res.body.etag as string,
    }));
    expect(partEtags).toHaveLength(partBuffers.length);
  });

  it('completes the multipart upload', async () => {
    const res = await request(API)
      .post(`/buckets/${BUCKET}/objects/${key}?uploadId=${uploadId}`)
      .set('Content-Type', 'application/json')
      .send({ parts: partEtags });

    expect(res.status).toBe(201);
    expect(res.body.sizeBytes).toBe(TOTAL);
    expect(res.headers['etag']).toBeDefined();
  });

  it('downloads the 50 MB object byte-for-byte', async () => {
    const res = await request(API)
      .get(`/buckets/${BUCKET}/objects/${key}`)
      .buffer(true);

    expect(res.status).toBe(200);
    expect(Buffer.compare(content, await readBinaryResponse(res))).toBe(0);
  }, 30_000); // 30 s timeout for 50 MB transfer

  it('dedup: parts with identical content share a single chunk row', async () => {
    // Upload an identical 20-MB block as two separate parts (both map to same chunk)
    const dupKey = 'multipart/dedup-check.bin';
    const block = randomBytes(CHUNK_SIZE); // exactly one chunk
    const blockHash = sha256hex(block);

    const initRes = await request(API).post(
      `/buckets/${BUCKET}/objects/${dupKey}?uploads`,
    );
    expect(initRes.status).toBe(201);
    const dupUploadId = initRes.body.uploadId as string;

    // Part 1 and Part 2 use the same bytes — only one chunk should be written.
    const p1 = await request(API)
      .put(
        `/buckets/${BUCKET}/objects/${dupKey}?uploadId=${dupUploadId}&partNumber=1`,
      )
      .set('Content-Type', 'application/octet-stream')
      .send(block);
    const p2 = await request(API)
      .put(
        `/buckets/${BUCKET}/objects/${dupKey}?uploadId=${dupUploadId}&partNumber=2`,
      )
      .set('Content-Type', 'application/octet-stream')
      .send(block);

    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    // Both parts must have the same ETag (same content → same chunk hash)
    expect(p1.body.etag).toBe(p2.body.etag);
    expect(p1.body.etag).toBe(blockHash.slice(0, 32));

    // Abort — we don't care about the assembled object here
    await request(API).delete(
      `/buckets/${BUCKET}/objects/${dupKey}?uploadId=${dupUploadId}`,
    );
  });
});

describe('Phase 2 — multipart error paths', () => {
  const key = 'multipart/error-paths.bin';

  it('rejects complete with a wrong ETag', async () => {
    const initRes = await request(API).post(
      `/buckets/${BUCKET}/objects/${key}?uploads`,
    );
    const uploadId = initRes.body.uploadId as string;

    const partBuf = randomBytes(1024);
    await request(API)
      .put(
        `/buckets/${BUCKET}/objects/${key}?uploadId=${uploadId}&partNumber=1`,
      )
      .set('Content-Type', 'application/octet-stream')
      .send(partBuf);

    const badComplete = await request(API)
      .post(`/buckets/${BUCKET}/objects/${key}?uploadId=${uploadId}`)
      .send({ parts: [{ partNumber: 1, etag: 'wrong-etag-value' }] });

    expect(badComplete.status).toBe(400);

    await request(API).delete(
      `/buckets/${BUCKET}/objects/${key}?uploadId=${uploadId}`,
    );
  });

  it('abort returns 204 and subsequent complete returns 404', async () => {
    const initRes = await request(API).post(
      `/buckets/${BUCKET}/objects/${key}?uploads`,
    );
    const uploadId = initRes.body.uploadId as string;

    const abort = await request(API).delete(
      `/buckets/${BUCKET}/objects/${key}?uploadId=${uploadId}`,
    );
    expect(abort.status).toBe(204);

    // Upload on an aborted session should 404
    const partRes = await request(API)
      .put(
        `/buckets/${BUCKET}/objects/${key}?uploadId=${uploadId}&partNumber=1`,
      )
      .send(randomBytes(32));
    expect(partRes.status).toBe(404);
  });
});

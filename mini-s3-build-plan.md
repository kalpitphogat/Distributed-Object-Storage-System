# Mini-S3 — Distributed Object Storage System
## Complete Engineering Build Plan (for SDE Portfolio / Resume Project)

---

## 0. How to use this document

This is written so that a software engineer (you, or someone you hand it to) can start coding on day one without needing to make architectural decisions from scratch. Every section gives concrete choices, not just options. Where there are tradeoffs, the recommended choice is marked **[DECISION]** along with the reasoning, so you can explain it in an interview.

Treat this as a living spec — update it as you build, and keep a `DECISIONS.md` in your repo logging anywhere you deviated from this plan and why (interviewers love this).

---

## 1. Project Summary

**What you're building:** A distributed object storage service that mimics the core internals of S3/GCS/MinIO — not a thin wrapper around an existing storage SDK, but the actual chunking, hashing, replication, and metadata logic that makes those systems work.

**Why it's worth 10-14 weeks:** Every component on this list (consistent hashing, quorum replication, read repair, content-addressable storage, mark-and-sweep GC) is a standalone hard problem that shows up in distributed systems interviews at every major tech company. Building a working version of each gives you a real, defensible answer — not a textbook answer — when an interviewer pushes on "but what happens when a node dies mid-write?"

**Definition of Done — three tiers:**

| Tier | Scope | What it proves |
|---|---|---|
| **MVP (must-have)** | Single-region cluster: chunked upload, content-addressable storage, consistent hashing ring, replication factor N, read repair, metadata in Postgres, versioning, GC, range requests, presigned URLs | Core distributed storage engineering |
| **Full (target)** | MVP + sharded metadata, hot-blob caching, node add/remove rebalancing, S3-compatible API surface | Production-scale thinking |
| **Stretch (differentiators)** | Full + erasure coding, lifecycle policies, bandwidth throttling, admin console with analytics | Goes beyond a typical "S3 clone" tutorial — this is what gets a 9-10/10 resume reaction |

Aim to finish MVP by week 6-7, Full by week 10, and use the remaining weeks for Stretch + polish + a recorded demo.

---

## 2. High-Level Architecture

Four logical regions, all owned by your code (the diagram above shows this):

1. **API layer** (NestJS) — receives HTTP requests, authenticates them, validates input, streams bytes in/out. Stateless — can run N copies behind a load balancer.
2. **Metadata store** (PostgreSQL + Redis) — the single source of truth for "what exists." Postgres holds durable relational data (buckets, objects, versions, chunk manifests). Redis holds ephemeral/fast-changing data (hash ring snapshot, rate-limit counters, distributed locks, hot-chunk cache).
3. **Storage ring** — N storage nodes, each a separate MinIO container, each acting as one node on a consistent hash ring. Mini-S3 never writes raw bytes to its own local disk; it always writes to one of these nodes through the MinIO S3 API. This is a deliberate scope decision (see §3).
4. **Background workers** — separate Node.js processes (not part of the request path) that run garbage collection, replica anti-entropy/repair, lifecycle policy enforcement, and ring rebalancing.

**Upload path (single-shot, small object):**
`Client → API (auth) → compute SHA-256 of body → check chunk table for existing hash (dedup) → if new, pick N nodes from hash ring → write to all N MinIO nodes → on quorum ack, write chunk + manifest rows to Postgres in one transaction → return ETag`

**Upload path (multipart, large object):**
`Client → POST .../uploads (initiate) → PUT part 1..k in parallel, each part chunked + hashed + replicated independently → POST .../complete with ordered list of part ETags → server validates, assembles manifest (logical, not physical concatenation) → object_version created`

**Download path:**
`Client → API (auth + presigned URL check if applicable) → look up latest (or specific) version's manifest → for each chunk in order, pick a healthy replica from the ring → stream bytes back, verifying SHA-256 as they pass through → if checksum mismatch, retry from another replica + trigger async read-repair`

---

## 3. Key Scope Decision: storage nodes are MinIO containers, not raw disks

**[DECISION]** Each "storage node" in your ring is a Docker container running MinIO, addressed by Mini-S3 through the standard S3 API (`PutObject`, `GetObject`, `GetObject` with `Range`, `DeleteObject`). Mini-S3's own code is responsible for everything *above* that: which node(s) a chunk goes to, how many copies, how to detect/repair a bad copy, how to garbage collect, how to version.

**Why:** Building a raw on-disk storage engine (free-list management, fsync semantics, page layout) is a multi-year filesystem-engineering problem and is *not* what storage-system interview questions are about. Interviewers ask about consistent hashing, replication, consistency models, and failure recovery — all of which live in the layer you're actually building. This decision is worth stating explicitly in your README so it reads as a deliberate scope cut, not a shortcut you're hiding.

---

## 4. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| API framework | NestJS (TypeScript) | Built-in DI makes it natural to swap a real `StorageNode` client for a mock in tests; interceptors are the right abstraction for streaming and range-handling; decorators keep auth/validation declarative |
| Metadata DB | PostgreSQL | ACID transactions are required when you write a chunk manifest + bump ref-counts atomically; relational model fits bucket→object→version→chunk naturally |
| Cache / coordination | Redis | Hash-ring snapshot caching, distributed locks (`SETNX` for GC sweep), token-bucket counters for bandwidth throttling, hot-chunk LRU |
| Storage backend | MinIO (N containers) | S3-compatible, lets you focus on distribution logic instead of disk I/O (see §3) |
| Streaming | Node.js streams (`Readable`/`Writable`/`Transform`) | Required so a 5 GB file never has to fully exist in process memory at once |
| Hashing | Custom consistent-hash-ring implementation (TypeScript) | Building it yourself is the actual interview-relevant skill; reference the `hashring` npm package only as a correctness oracle in tests |
| Admin console | Next.js | SSR dashboard for per-bucket analytics, server actions can hit the same Postgres directly |
| Background jobs | BullMQ (Redis-backed queues) | Repeatable jobs for GC, anti-entropy, lifecycle sweeps; gives you retry/backoff for free |
| Containerization | Docker + Docker Compose | Lets you spin up a 5-node MinIO cluster + Postgres + Redis + API + workers with one command — essential for demoing replication/failure scenarios |
| Load testing | k6 or Artillery | Needed to demonstrate the hot-blob and throughput numbers you'll put on your resume |
| Erasure coding (stretch) | Reed-Solomon via `reed-solomon-erasure` npm bindings, or a hand-rolled XOR scheme for the m=1 case | Real RS math is complex; a working m=1 (single-parity) XOR scheme is enough to demonstrate and explain the concept, with RS as a documented stretch-stretch goal |

---

## 5. Repository Structure

```
mini-s3/
├── apps/
│   ├── api/                 # NestJS — public REST/S3-compatible API
│   │   ├── src/
│   │   │   ├── auth/        # access keys, presigned URL verification
│   │   │   ├── buckets/
│   │   │   ├── objects/     # upload, download, range, versions
│   │   │   ├── multipart/
│   │   │   ├── storage/     # hash ring, replica client, read-repair
│   │   │   └── admin/       # analytics endpoints consumed by admin app
│   ├── worker/               # standalone Node process — GC, repair, lifecycle, rebalance
│   └── admin-console/         # Next.js dashboard
├── packages/
│   ├── hash-ring/             # standalone, unit-tested consistent hashing library
│   ├── sdk/                   # thin TS client others can `npm install` to hit your API
│   └── shared-types/
├── infra/
│   ├── docker-compose.yml     # postgres, redis, 5x minio, api, worker, admin
│   └── migrations/            # SQL migration files (e.g. node-pg-migrate)
├── tests/
│   ├── unit/
│   ├── integration/
│   └── chaos/                 # node-kill, network-partition simulation scripts
└── DECISIONS.md
```

---

## 6. Database Schema (PostgreSQL)

```sql
-- Buckets: top-level namespace
CREATE TABLE buckets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(63) UNIQUE NOT NULL,
  owner_id        UUID NOT NULL,
  versioning_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Access keys for auth + HMAC signing
CREATE TABLE access_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  access_key_id   VARCHAR(40) UNIQUE NOT NULL,
  secret_key_hash VARCHAR(128) NOT NULL,   -- bcrypt hash, never store plaintext
  owner_id        UUID NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Objects: a key within a bucket. The "current pointer".
CREATE TABLE objects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id         UUID NOT NULL REFERENCES buckets(id),
  object_key        TEXT NOT NULL,
  latest_version_id UUID,                 -- FK added after object_versions exists
  is_deleted        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, object_key)
);

-- Object versions: append-only history per object
CREATE TABLE object_versions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id        UUID NOT NULL REFERENCES objects(id),
  version_number   BIGINT NOT NULL,        -- monotonic per object, not global
  size_bytes        BIGINT NOT NULL DEFAULT 0,
  content_sha256    CHAR(64),               -- whole-object hash (for single-chunk/small objects)
  etag              VARCHAR(64) NOT NULL,
  is_delete_marker  BOOLEAN NOT NULL DEFAULT false,
  storage_class     VARCHAR(16) NOT NULL DEFAULT 'STANDARD',  -- STANDARD | COLD
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (object_id, version_number)
);

ALTER TABLE objects
  ADD CONSTRAINT fk_latest_version
  FOREIGN KEY (latest_version_id) REFERENCES object_versions(id);

-- Chunks: content-addressable, deduplicated by hash
CREATE TABLE chunks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_sha256   CHAR(64) UNIQUE NOT NULL,
  size_bytes       INTEGER NOT NULL,
  ref_count        INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Manifest: ordered list of chunks that make up one object version
CREATE TABLE object_version_chunks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_version_id   UUID NOT NULL REFERENCES object_versions(id),
  chunk_id             UUID NOT NULL REFERENCES chunks(id),
  chunk_index          INTEGER NOT NULL,     -- 0-based order within the object
  byte_offset          BIGINT NOT NULL,      -- cumulative offset, used for Range lookups
  UNIQUE (object_version_id, chunk_index)
);
CREATE INDEX idx_ovc_offset ON object_version_chunks (object_version_id, byte_offset);

-- Storage nodes participating in the ring
CREATE TABLE storage_nodes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_url           VARCHAR(255) NOT NULL,
  status             VARCHAR(16) NOT NULL DEFAULT 'active',  -- active|draining|down
  capacity_bytes     BIGINT NOT NULL,
  used_bytes         BIGINT NOT NULL DEFAULT 0,
  virtual_node_count INTEGER NOT NULL DEFAULT 150,
  last_heartbeat_at  TIMESTAMPTZ
);

-- Which nodes hold a copy of which chunk, and replica health
CREATE TABLE chunk_replicas (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id         UUID NOT NULL REFERENCES chunks(id),
  storage_node_id  UUID NOT NULL REFERENCES storage_nodes(id),
  status           VARCHAR(16) NOT NULL DEFAULT 'active',  -- active|stale|missing
  last_verified_at TIMESTAMPTZ,
  UNIQUE (chunk_id, storage_node_id)
);
CREATE INDEX idx_replicas_chunk ON chunk_replicas (chunk_id);

-- Multipart upload session
CREATE TABLE multipart_uploads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- this is the uploadId
  bucket_id       UUID NOT NULL REFERENCES buckets(id),
  object_key      TEXT NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'in_progress', -- in_progress|completed|aborted
  initiated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE multipart_parts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id    UUID NOT NULL REFERENCES multipart_uploads(id),
  part_number  INTEGER NOT NULL,
  chunk_id     UUID REFERENCES chunks(id),
  etag         VARCHAR(64),
  size_bytes   INTEGER,
  UNIQUE (upload_id, part_number)
);

-- Lifecycle rules per bucket
CREATE TABLE lifecycle_policies (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id                   UUID NOT NULL REFERENCES buckets(id),
  prefix                      TEXT,
  expire_after_days           INTEGER,
  transition_to_cold_after_days INTEGER,
  enabled                     BOOLEAN NOT NULL DEFAULT true
);

-- Rolling counters for the admin analytics dashboard
CREATE TABLE bucket_stats (
  bucket_id          UUID PRIMARY KEY REFERENCES buckets(id),
  total_objects      BIGINT NOT NULL DEFAULT 0,
  total_bytes        BIGINT NOT NULL DEFAULT 0,
  bandwidth_bytes_30d BIGINT NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Why this shape:** the `chunks` table is the dedup point — two different objects (even in different buckets, different owners) that happen to contain an identical 8 MB block will point at the *same* chunk row, and `ref_count` tracks how many manifests reference it. This is what makes content-addressable storage interesting to talk about in interviews (it's literally how Git and S3-with-dedup work).

---

## 7. Core Component Design

### 7.1 Content-Addressable Storage

- On any write, compute `SHA-256(chunk_bytes)` as the chunk's identity.
- Before writing to the ring, check `chunks` table: if a row with that hash already exists, **skip the network write entirely** — just increment `ref_count` and add a manifest row. This is real deduplication, not simulated.
- Storage key on each MinIO node = `sha256/{hash[0:2]}/{hash[2:4]}/{hash}` — the two-level prefix avoids putting millions of objects in one flat MinIO "folder," which is a real performance concern worth mentioning in an interview.

```ts
async function writeChunk(bytes: Buffer): Promise<ChunkRef> {
  const hash = sha256Hex(bytes);
  const existing = await db.chunks.findByHash(hash);
  if (existing) {
    await db.chunks.incrementRefCount(existing.id);
    return existing;
  }
  const nodes = hashRing.getReplicaNodes(hash, REPLICATION_FACTOR);
  const acks = await Promise.allSettled(
    nodes.map(n => minioClient(n).putObject(bucketFor(n), keyFor(hash), bytes))
  );
  const successCount = acks.filter(a => a.status === 'fulfilled').length;
  if (successCount < WRITE_QUORUM) throw new InsufficientReplicasError();
  return db.transaction(async tx => {
    const chunk = await tx.chunks.insert({ content_sha256: hash, size_bytes: bytes.length, ref_count: 1 });
    await tx.chunkReplicas.insertMany(nodes.map(n => ({ chunk_id: chunk.id, storage_node_id: n.id, status: 'active' })));
    return chunk;
  });
}
```

### 7.2 Chunked Upload & Multipart Assembly

- **[DECISION]** Default chunk size: **8 MB**. Range 5 MB (S3's own minimum part size) to 100 MB is configurable per bucket.
- Single-shot upload (`PUT /:bucket/:key`): for objects under one chunk size, do it in one round trip.
- Multipart, three calls:
  1. `POST /:bucket/:key?uploads` → creates a `multipart_uploads` row, returns `uploadId`
  2. `PUT /:bucket/:key?partNumber=N&uploadId=X` (called in parallel by the client, one per part) → each part is itself chunk-hashed and replicated via `writeChunk`, recorded in `multipart_parts`
  3. `POST /:bucket/:key?uploadId=X` with a body listing `{partNumber, etag}` pairs in order → server validates every part's stored ETag matches what the client claims, then **logically** assembles the final manifest by copying `multipart_parts` → `object_version_chunks` in order. No physical re-write of bytes is needed — this is the same trick S3 itself uses.
- Abort: `DELETE /:bucket/:key?uploadId=X` → marks upload aborted, decrements ref-counts on any chunks that aren't referenced elsewhere (cleanup happens via the normal GC worker).

### 7.3 Consistent Hashing Ring

**[DECISION]** Build this yourself in `packages/hash-ring`. Use SHA-1 (or MurmurHash3 for speed) to map both physical nodes and "virtual nodes" onto a 0–2³²-1 circle.

- Each physical storage node gets **150 virtual nodes** by default (`hash(nodeId + ":" + i)` for `i` in `0..149`). More virtual nodes = smoother load distribution when a node joins/leaves.
- Ring is a sorted array of `{ position: number, physicalNodeId: string }`, looked up with binary search.
- **Replica selection:** walk clockwise from `hash(chunkHash)`, collecting **distinct physical node IDs** (skip virtual nodes that map to a physical node already selected) until you have `REPLICATION_FACTOR` nodes. This is the standard technique to avoid two replicas landing on the same physical machine even though it has many virtual nodes.

```ts
class HashRing {
  private ring: { position: number; nodeId: string }[] = [];

  addNode(nodeId: string, virtualNodes = 150) {
    for (let i = 0; i < virtualNodes; i++) {
      this.ring.push({ position: hash(`${nodeId}:${i}`), nodeId });
    }
    this.ring.sort((a, b) => a.position - b.position);
  }

  removeNode(nodeId: string) {
    this.ring = this.ring.filter(e => e.nodeId !== nodeId);
  }

  getReplicaNodes(key: string, count: number): string[] {
    const target = hash(key);
    const startIdx = binarySearchFirstGTE(this.ring, target);
    const result: string[] = [];
    for (let i = 0; i < this.ring.length && result.length < count; i++) {
      const candidate = this.ring[(startIdx + i) % this.ring.length].nodeId;
      if (!result.includes(candidate)) result.push(candidate);
    }
    return result;
  }
}
```

- Keep a **cached snapshot** of the ring in Redis so every API instance doesn't recompute it; invalidate on node add/remove events (pub/sub).

### 7.4 Replication

- **[DECISION]** Default replication factor (RF) = 3, configurable per bucket.
- **Write quorum (W) = 2 of 3**: a write is acknowledged to the client once 2 of the 3 target nodes confirm the bytes are durably stored. The third write continues in the background; if it fails, the chunk is flagged `under-replicated` for the repair worker to fix.
- **Read quorum (R) = 1**: any single healthy replica can serve a read, because chunk identity *is* its hash — you can always verify correctness locally by re-hashing what you got back. This is the practical benefit of content-addressable storage: you get strong read consistency without needing a read quorum vote.
- Consistency model to describe in interviews: **this is eventually-consistent on the write path (W=2 of 3) but strongly verifiable on the read path** (because of content hashing) — a hybrid that's easier to reason about than vanilla Dynamo-style eventual consistency.

### 7.5 Read Repair

```ts
async function readChunk(chunkHash: string): Promise<Buffer> {
  const replicas = await db.chunkReplicas.findActiveByChunk(chunkHash);
  for (const replica of orderByLeastRecentlyUsed(replicas)) {
    try {
      const bytes = await minioClient(replica.node).getObject(keyFor(chunkHash));
      if (sha256Hex(bytes) === chunkHash) return bytes;
      markReplicaStale(replica); // checksum mismatch -- don't trust this copy
    } catch (err) {
      markReplicaUnreachable(replica);
    }
  }
  throw new AllReplicasFailedError(chunkHash);
}

// Fire-and-forget after a successful read from a degraded set
async function scheduleRepair(chunkHash: string, goodBytes: Buffer, badReplicaId: string) {
  await repairQueue.add('repair-chunk', { chunkHash, badReplicaId, bytes: goodBytes });
}
```

- Background **anti-entropy worker** also runs independently of reads: every N minutes, sample a random batch of chunks, verify every replica's checksum, repair anything stale — so chunks that are never read still get healed.

### 7.6 Metadata Server

- All metadata lookups go through Postgres, fronted by a Redis cache for hot reads (`GET object → manifest`).
- Cache invalidation: write-through on any version create/delete — update Postgres and Redis in the same code path (delete-then-repopulate is safest, avoids stale-cache races).
- Manifest fetch returns an ordered array, e.g.:
```json
{
  "objectVersionId": "...",
  "sizeBytes": 26214400,
  "chunks": [
    { "index": 0, "hash": "ab12...", "sizeBytes": 8388608, "byteOffset": 0 },
    { "index": 1, "hash": "cd34...", "sizeBytes": 8388608, "byteOffset": 8388608 },
    { "index": 2, "hash": "ef56...", "sizeBytes": 9437184, "byteOffset": 16777216 }
  ]
}
```

### 7.7 Pre-signed URLs (HMAC-SHA256)

```ts
function generatePresignedUrl(bucket: string, key: string, method: 'GET'|'PUT', expiresInSeconds: number, accessKeyId: string, secretKey: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const stringToSign = `${method}\n${bucket}\n${key}\n${expiresAt}`;
  const signature = crypto.createHmac('sha256', secretKey).update(stringToSign).digest('hex');
  return `https://api.example.com/${bucket}/${key}` +
    `?Expires=${expiresAt}&AccessKeyId=${accessKeyId}&Signature=${signature}`;
}

// Verification middleware
async function verifyPresignedUrl(req: Request): Promise<boolean> {
  const { Expires, AccessKeyId, Signature } = req.query;
  if (Number(Expires) < Math.floor(Date.now() / 1000)) return false; // expired
  const secretKey = await getSecretKeyFor(AccessKeyId as string);
  const stringToSign = `${req.method}\n${req.params.bucket}\n${req.params.key}\n${Expires}`;
  const expected = crypto.createHmac('sha256', secretKey).update(stringToSign).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(Signature as string));
}
```

- Always use `crypto.timingSafeEqual` — a naive `===` string comparison is a timing side-channel, and pointing this out unprompted is a good interview signal.

### 7.8 Garbage Collection (mark-and-sweep)

- **Mark phase** (runs first, read-only): build a "live set" of every `chunk_id` referenced by any `object_version_chunks` row belonging to a non-deleted version, **plus** any version younger than a configurable grace period (e.g. 7 days) even if soft-deleted — this protects the version-restore window.
- **Sweep phase**: for every chunk where `ref_count = 0` AND it's not in the live set AND it's older than the grace period, delete it from all replicas, then delete the `chunks` row.
- Run as a repeatable BullMQ job, e.g. hourly. Use a Redis lock (`SET gc:lock NX EX 600`) so only one worker instance runs the sweep at a time.
- Log every GC run's `chunks_scanned` / `chunks_deleted` — this gives you a real number for your resume ("garbage collector reclaimed X GB across Y runs in load testing").

### 7.9 Versioning

- Every successful write (full or multipart-complete) creates a new row in `object_versions` with an incremented `version_number`; `objects.latest_version_id` is updated in the same transaction.
- `DELETE` on a versioned bucket doesn't remove data — it inserts a new version with `is_delete_marker = true` and zero chunks, and that becomes latest. `GET` on an object whose latest version is a delete marker returns 404, but the object is still fully recoverable.
- **Restore:** creating a "new" version that points at the *same* chunk rows as an older version is cheap — no chunk bytes move. Just insert new `object_version_chunks` rows referencing the existing `chunk_id`s (and bump their `ref_count`), then update `latest_version_id`.
- `GET /:bucket/:key?versions` lists the full chain; `GET /:bucket/:key?versionId=X` fetches a specific one.

### 7.10 Range Requests

```ts
async function streamRange(objectVersionId: string, start: number, end: number, res: Response) {
  const manifest = await getManifest(objectVersionId);
  const relevantChunks = manifest.chunks.filter(c =>
    c.byteOffset < end && (c.byteOffset + c.sizeBytes) > start
  );
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${manifest.sizeBytes}`);
  res.setHeader('Accept-Ranges', 'bytes');

  for (const chunk of relevantChunks) {
    const chunkStart = Math.max(0, start - chunk.byteOffset);
    const chunkEnd = Math.min(chunk.sizeBytes - 1, end - chunk.byteOffset);
    const partialStream = await getChunkRangeStream(chunk.hash, chunkStart, chunkEnd); // MinIO supports native Range GETs
    await pipeStream(partialStream, res, { end: false });
  }
  res.end();
}
```

- This is what makes resumable downloads and video scrubbing work — the manifest's `byteOffset` column exists specifically to make this lookup O(chunks-in-range) instead of needing to read the whole object.

---

## 8. REST API Specification (S3-compatible surface)

| Method | Path | Purpose | Auth |
|---|---|---|---|
| PUT | `/:bucket` | Create bucket | Access key |
| GET | `/:bucket` | List objects (prefix, delimiter, pagination) | Access key |
| PUT | `/:bucket/lifecycle` | Set lifecycle policy | Access key |
| PUT | `/:bucket/versioning` | Enable/disable versioning | Access key |
| PUT | `/:bucket/:key` | Upload object (single-shot) | Access key or presigned |
| GET | `/:bucket/:key` | Download object (supports `Range` header) | Access key or presigned |
| HEAD | `/:bucket/:key` | Object metadata only | Access key or presigned |
| DELETE | `/:bucket/:key` | Delete (soft if versioned) | Access key |
| GET | `/:bucket/:key?versions` | List version history | Access key |
| GET | `/:bucket/:key?versionId=X` | Get specific version | Access key |
| PUT | `/:bucket/:key?versionId=X&restore=true` | Restore old version to latest | Access key |
| POST | `/:bucket/:key?uploads` | Initiate multipart upload | Access key |
| PUT | `/:bucket/:key?partNumber=N&uploadId=X` | Upload one part | Access key |
| POST | `/:bucket/:key?uploadId=X` | Complete multipart upload | Access key |
| DELETE | `/:bucket/:key?uploadId=X` | Abort multipart upload | Access key |
| GET | `/presign?bucket=&key=&method=&expiresIn=` | Generate a presigned URL | Access key |
| GET | `/admin/buckets/:bucket/stats` | Storage/bandwidth/object-count analytics | Admin key |
| GET | `/admin/nodes` | Storage node health + load | Admin key |

Matching this surface to real S3 verbs (`uploads`, `partNumber`, `uploadId` as query params, `Range` headers, `ETag` semantics) is what lets you point the actual `@aws-sdk/client-s3` package at your server with just a custom `endpoint` — a strong, demoable differentiator.

---

## 9. Background Workers

| Worker | Trigger | What it does |
|---|---|---|
| GC (mark-and-sweep) | Hourly cron | See §7.8 |
| Anti-entropy / read-repair | Every 15 min, samples chunks | Verifies replica checksums proactively, not just on read |
| Lifecycle enforcer | Daily cron | Scans `lifecycle_policies`, expires or transitions objects past their age threshold |
| Rebalancer | Triggered on node add/remove event | Walks the ring, finds chunks whose new replica set differs from their old one, migrates only those chunks (throttled) |

---

## 10. Scalability Solutions

### 10.1 Hot blob problem
A single popular object gets hammered by thousands of concurrent readers. Solve with:
- **Redis-based hot-chunk cache**: cache the *bytes* of chunks above a read-frequency threshold (LRU, capped size) so repeat reads skip MinIO entirely.
- **`Cache-Control` / `ETag` headers** on every GET so a real CDN (or even browser caching) can sit in front of your API for actual production use.
- **Read replicas**: since read quorum is 1, you can freely round-robin reads across all 3 replicas of a hot chunk instead of always hitting the "primary," spreading load.

### 10.2 Metadata bottleneck
A single Postgres instance becomes the ceiling once object count gets large.
- **[DECISION]** Shard by `bucket_id`: hash `bucket_id` to pick one of M Postgres instances (or M schemas on fewer instances, if you don't want to run 4 separate Postgres containers for a portfolio project — document both options and pick based on your hardware).
- Add **PgBouncer** for connection pooling regardless of sharding — cheap to add, real production lesson to talk about.
- Cite **Citus** (Postgres extension for native sharding) as the production-grade evolution path even if you implement manual application-level sharding for the project.

### 10.3 Chunk placement / rebalancing
When a node is added or removed, you don't want to reshuffle all chunks.
- Virtual nodes (§7.3) already bound the disruption: adding 1 node to a ring of N nodes moves roughly `1/(N+1)` of the keyspace, not everything.
- The **rebalancer worker** computes the diff between old and new replica assignment for every chunk and only migrates the chunks that actually changed owners, throttled to a configurable MB/s so it doesn't starve live traffic.

---

## 11. Differentiating / Advanced Features

### 11.1 S3-compatible API
Write integration tests that literally instantiate `@aws-sdk/client-s3` pointed at `http://localhost:3000` with a custom endpoint and `forcePathStyle: true`, and run real `PutObjectCommand` / `GetObjectCommand` / multipart commands against your server. This is the single most convincing demo you can put in a README GIF.

### 11.2 Erasure coding (advanced)
- **[DECISION]** Implement the **m=1 case by hand** first: store `k` data chunks plus 1 parity chunk computed as the XOR of all `k` chunks. If any single chunk is lost, recover it by XOR-ing the remaining `k` chunks against the parity. This is genuinely how RAID-5 parity works and is simple enough to implement, test, and explain in under a day.
- Document Reed-Solomon (k+m, recovers from any m failures) as the real-world generalization, and optionally wire in a library (`reed-solomon-erasure` via WASM bindings) as a stretch-stretch goal if time allows — but don't let it block the rest of the plan.
- Make this **opt-in per bucket** (`storage_mode: 'replication' | 'erasure_coding'`) so you can demo both side by side and talk about the tradeoff: erasure coding uses less storage overhead for the same fault tolerance, but costs more CPU on every read/write and is worse for small, frequently-read objects.

### 11.3 Lifecycle policies
Daily worker reads `lifecycle_policies`, finds object versions older than `expire_after_days` → deletes them (creating delete markers if versioned); finds versions older than `transition_to_cold_after_days` → updates `storage_class = 'COLD'` and optionally moves their chunks to a dedicated "cold" MinIO bucket with cheaper-tier disk in your docker-compose (label it as such even if it's the same disk — the logic is what matters).

### 11.4 Bandwidth throttling per bucket
Token-bucket algorithm in Redis: each bucket gets `bandwidth_limit_mbps` and a Redis key tracking tokens consumed in the current window. A NestJS interceptor checks/decrements tokens before streaming response bytes; if the bucket is empty, delay the stream (don't reject the request — throttle, don't drop).

### 11.5 Admin console with analytics
Next.js app reading directly from `bucket_stats` (updated incrementally by the API on every write/read, not recomputed from scratch) showing: storage used over time, bandwidth consumed, object count, replica health per node, GC run history. Use simple server-rendered charts (Recharts) — the value here is the *data model*, not flashy UI.

---

## 12. Week-by-Week Development Plan (target: 12 weeks, flexible 10-14)

### Phase 0 — Setup (Week 1)
- Scaffold monorepo (`apps/api`, `apps/worker`, `apps/admin-console`, `packages/hash-ring`)
- Docker Compose: Postgres, Redis, 1 MinIO container to start
- Run all SQL migrations from §6
- **DoD:** `docker-compose up` brings up a healthy stack; NestJS app responds to a health-check endpoint

### Phase 1 — Single-node storage + metadata (Weeks 2-3)
- Implement bucket CRUD, single-shot object PUT/GET against the one MinIO node (no hashing/replication yet)
- Implement content-addressable hashing + dedup logic (§7.1) against that single node
- Implement manifest read/write
- **DoD:** can PUT and GET an object, verify it round-trips byte-for-byte, verify uploading the same content twice doesn't duplicate storage

### Phase 2 — Chunking + multipart (Weeks 3-4)
- Implement chunk splitting for objects above one chunk size
- Implement the 3-call multipart flow (§7.2)
- **DoD:** upload a 50 MB file via multipart with parts uploaded in parallel from a test script, download it back, verify byte-for-byte match

### Phase 3 — Distributed storage: hash ring + replication + read repair (Weeks 5-7)
- Build and unit-test `packages/hash-ring` in isolation (no I/O — pure data structure tests)
- Stand up 5 MinIO containers in docker-compose, register them as `storage_nodes`
- Wire writes to go through the ring with RF=3, write quorum=2
- Implement read-repair (§7.5) and the anti-entropy background worker
- **Chaos test:** kill one MinIO container mid-traffic, verify writes still succeed (quorum), verify reads still succeed (from remaining replicas), bring the node back, verify repair worker heals it
- **DoD:** all of the above pass as automated integration tests, not just manual checks

### Phase 4 — Versioning + GC + range requests (Weeks 7-9)
- Implement versioning, delete markers, restore (§7.9)
- Implement mark-and-sweep GC as a BullMQ job (§7.8) — test by uploading, deleting, and asserting chunks disappear from storage after a GC run, but not before the grace period
- Implement Range header support (§7.10) — test partial downloads of a large file at several byte ranges, including overlapping two chunks
- **DoD:** version history is browsable and restorable; orphaned chunks are provably reclaimed; `curl -r 1000-2000` returns exactly the right bytes

### Phase 5 — Presigned URLs + auth + S3 SDK compatibility (Weeks 9-10)
- Implement access keys, HMAC presigned URL generation/verification (§7.7)
- Point `@aws-sdk/client-s3` at your API and get `PutObjectCommand`/`GetObjectCommand`/multipart commands working unmodified
- **DoD:** a real AWS SDK client, configured only with a custom endpoint, can upload/download/list/delete against your server

### Phase 6 — Scalability features (Weeks 10-11)
- Metadata sharding by `bucket_id` (§10.2) — at minimum, implement and test the sharding logic; running it across multiple real Postgres instances is a bonus
- Hot-chunk Redis cache + cache headers (§10.1)
- Node add/remove rebalancer worker (§10.3) — test by adding a 6th MinIO node live and confirming only a fraction of chunks migrate
- **DoD:** load test shows cache hit ratio improving repeat-read latency; adding a node visibly migrates less than 100% of data

### Phase 7 — Differentiating features (Weeks 11-13)
- Lifecycle policies (auto-expire, auto-cold-transition) — §11.3
- Bandwidth throttling per bucket — §11.4
- m=1 erasure coding mode as an alternative to replication, opt-in per bucket — §11.2
- Admin console: bucket stats dashboard, node health view — §11.5
- **DoD:** each feature has its own integration test; admin console renders real numbers from a load-tested bucket

### Phase 8 — Testing, load testing, docs, polish (Week 13-14)
- Full test pass: unit (hash ring, HMAC, manifest math), integration (every API endpoint), chaos (node failures), load (k6 script simulating the hot-blob scenario — e.g. 500 concurrent GETs on one object)
- Record actual numbers: throughput (MB/s), p99 latency under load, GC reclaim rate, rebalance migration percentage
- Write the README: architecture diagram, setup instructions, the numbers above, and a short "design decisions and tradeoffs" section
- Record a 2-3 minute demo screen recording: upload → kill a node → still works → show admin dashboard

---

## 13. Testing Strategy

- **Unit tests:** hash ring (`getReplicaNodes` distribution and stability under add/remove), HMAC sign/verify, byte-range-to-chunk-overlap math, token-bucket throttling logic
- **Integration tests:** every endpoint in §8, run against a real (test) Postgres + Redis + MinIO via docker-compose in CI
- **Chaos tests:** scripted node kill mid-write, mid-read; network delay injection (e.g. via `toxiproxy`) between API and one MinIO node, asserting timeouts/fallbacks behave correctly
- **Load tests (k6):** hot-blob scenario (N concurrent GETs on one key), sustained multipart upload throughput, GC worker performance under a large chunk count
- **Erasure coding correctness test:** deliberately corrupt/delete one of `k+1` shards, assert the missing data is recoverable via XOR

---

## 14. Deployment & Infra

`infra/docker-compose.yml` should bring up, at minimum:
- `postgres` (with a volume, migrations run on startup)
- `redis`
- `minio-1` through `minio-5` (each with its own volume)
- `api` (NestJS, can be scaled with `docker-compose up --scale api=3` behind a simple nginx load balancer for the demo)
- `worker` (background jobs)
- `admin-console` (Next.js)

**CI/CD (GitHub Actions):** on every PR — lint, unit tests, spin up the docker-compose stack, run integration tests against it, tear down. On merge to main — build and push Docker images.

**Production notes to mention in README** (don't need to fully build): Kubernetes StatefulSets for storage nodes, a real CDN in front of the API for hot blobs, secrets via a vault rather than `.env` files, TLS termination at a load balancer.

---

## 15. Observability

- Structured JSON logging (e.g. `pino`) with a correlation ID per request, propagated through to background job logs when a request triggers one
- Prometheus metrics: request latency histograms per endpoint, replica health gauge per node, GC chunks-deleted counter, cache hit ratio
- A simple Grafana dashboard (even just 4-5 panels) is a strong visual to screenshot for your README

---

## 16. Security Considerations

- Never store secret keys in plaintext — bcrypt hash them (see `access_keys.secret_key_hash`)
- All presigned URL comparisons use `crypto.timingSafeEqual`, never `===`
- All DB access through parameterized queries / an ORM (no string-concatenated SQL, ever)
- Validate bucket names and object keys against an allowlist pattern to avoid path-traversal-style key names reaching MinIO
- Rate-limit auth attempts and presigned URL generation per access key
- Document that production TLS termination would happen at the load balancer, not in NestJS itself

---

## 17. Resume & Interview Prep

**Resume bullet examples (fill in your real measured numbers from Phase 8 load tests):**
- "Built a distributed object storage system in NestJS/PostgreSQL implementing content-addressable storage, consistent hashing across 5 storage nodes, and quorum-based replication (RF=3); sustained [X] MB/s under [Y] concurrent multipart uploads"
- "Implemented mark-and-sweep garbage collection and anti-entropy read-repair, automatically detecting and healing [Z]% of injected replica corruption in chaos tests"
- "Achieved AWS SDK compatibility, validated by running unmodified `@aws-sdk/client-s3` operations against the custom API server"

**Anticipated interview questions and where the answer lives in your project:**
| Question | Where you point to |
|---|---|
| "What's your consistency model?" | §7.4 — write quorum 2-of-3, content-hash-verified reads |
| "What happens if a node dies during a write?" | §7.4 write quorum + Phase 3 chaos test |
| "How do you avoid hot spots when a node joins/leaves?" | §7.3 virtual nodes, §10.3 rebalancer |
| "How do you handle large file uploads without OOMing the server?" | §7.2 multipart + Node.js streams throughout |
| "How would you scale metadata past one Postgres instance?" | §10.2 sharding by bucket_id |
| "How do you reclaim storage from deleted files?" | §7.8 mark-and-sweep, with the grace period explained |
| "Why content-addressable storage instead of path-based?" | §7.1 — dedup + read consistency win from §7.4 |

**README checklist for the actual submission:**
- Architecture diagram (recreate the structural diagram style used above)
- Setup instructions (`docker-compose up`, seed script)
- Measured numbers from load testing
- A "Design Decisions" section mirroring the **[DECISION]** markers in this plan
- 2-3 minute demo recording link

---

## 18. Milestone Checklist (quick reference)

- [ ] Repo scaffolded, docker-compose stack healthy
- [ ] Single-node CAS upload/download with dedup working
- [ ] Multipart upload (3-call flow) working end to end
- [ ] Custom hash ring built and unit-tested in isolation
- [ ] RF=3 replication with write quorum=2 across 5 MinIO nodes
- [ ] Read repair + anti-entropy worker passing chaos tests
- [ ] Versioning, delete markers, restore working
- [ ] Mark-and-sweep GC reclaiming storage on schedule
- [ ] Range requests returning correct partial bytes across chunk boundaries
- [ ] Presigned URLs (HMAC-SHA256) generating and verifying correctly
- [ ] Real AWS SDK client working against your API unmodified
- [ ] Metadata sharding by bucket_id implemented
- [ ] Hot-chunk caching demonstrably improving repeat-read latency
- [ ] Node add/remove rebalancer migrating only the affected chunk subset
- [ ] Lifecycle policies (expire/cold-transition) running on schedule
- [ ] Bandwidth throttling enforced per bucket
- [ ] m=1 erasure coding mode working as a bucket-level option
- [ ] Admin console showing real per-bucket analytics
- [ ] Full test suite (unit/integration/chaos/load) green in CI
- [ ] README + demo recording finished

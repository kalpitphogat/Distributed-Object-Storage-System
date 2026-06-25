# Mini-S3 — Distributed Object Storage System

A production-grade distributed object storage system built as a portfolio project demonstrating senior distributed-systems engineering. Compatible with core AWS S3 semantics (PUT/GET/DELETE, multipart uploads, presigned URLs, versioning, range requests).

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Client / SDK                                 │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ HTTP
┌──────────────────────────▼───────────────────────────────────────────┐
│                      NestJS API (port 3000)                          │
│  BucketsController  ObjectsController  AuthController  AdminController│
│         │                  │                │               │        │
│  BucketsService    ObjectsService    AuthService    AdminService      │
│                         │                                            │
│              ┌──────────▼──────────┐                                │
│              │    ChunkService      │  ← dedup, quorum, hot cache    │
│              │    RingService       │  ← consistent hash ring        │
│              │    StorageService    │  ← per-node S3 clients         │
│              └──────────┬──────────┘                                │
└─────────────────────────┼────────────────────────────────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
  ┌────▼────┐        ┌────▼────┐        ┌────▼────┐   (RF=3 ring)
  │ MinIO-1 │        │ MinIO-2 │        │ MinIO-3 │
  └─────────┘        └─────────┘        └─────────┘
  ┌─────────┐        ┌─────────┐
  │ MinIO-4 │        │ MinIO-5 │
  └─────────┘        └─────────┘

  ┌─────────────────┐    ┌──────────────────────┐
  │   PostgreSQL     │    │       Redis           │
  │  metadata store  │    │  ring cache / tokens  │
  └─────────────────┘    └──────────────────────┘

  ┌──────────────────────────────────────────────┐
  │           BullMQ Worker                      │
  │  anti-entropy (15min) │ GC (hourly)           │
  │  lifecycle (daily)                           │
  └──────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────┐
  │        Admin Console — Next.js (port 3001)   │
  │  Dashboard │ Node Health │ GC Stats           │
  └──────────────────────────────────────────────┘
```

## Key Design Decisions

| Concern | Decision | Why |
|---|---|---|
| **Chunk identity** | SHA-256 content address | Two objects sharing a 8 MB block store one copy; hash IS the ID so verification is free |
| **Replication** | RF=3, W=2 quorum | Tolerate one node loss without data unavailability; W=2 acknowledges durability without waiting for the slowest replica |
| **Read consistency** | R=1 + local CAS verify | No read quorum needed — re-hashing the retrieved bytes confirms authenticity |
| **Ring** | Consistent hashing, 150 virtual nodes | Smooth load distribution; only ~1/(N+1) keys reassigned on membership change |
| **Hot chunk cache** | Redis, 5-min TTL, ≤1 MB | Absorbs popular small blobs without hitting MinIO on every request |
| **Presigned URLs** | HMAC-SHA256, absolute expiry | Timing-safe comparison prevents brute-force; absolute timestamp avoids clock-skew bugs |
| **GC** | Mark-and-sweep, 1h grace period | ref_count=0 chunks survive a crash window before GC claims them |
| **Versioning** | Append-only object_versions rows | Restore is zero-copy: just re-point latest_version_id |

## Running

**Prerequisites:** Docker Desktop, Docker Compose, pnpm

```bash
# Start infrastructure + API + worker + admin console
cd infra
docker compose up --build -d

# Verify the API is healthy
curl http://localhost:3000/health

# Run all integration tests (phases 1–5)
cd ..
pnpm --filter @mini-s3/api test:integration

# Open admin console
open http://localhost:3001
```

## API Reference

### Buckets
| Method | Path | Description |
|---|---|---|
| `PUT` | `/buckets/:name` | Create bucket |
| `GET` | `/buckets` | List all buckets |
| `GET` | `/buckets/:name` | Get bucket metadata |
| `DELETE` | `/buckets/:name` | Delete bucket |
| `PUT` | `/buckets/:name/versioning` | Enable/disable versioning (`{ enabled: boolean }`) |
| `PUT` | `/buckets/:name/lifecycle` | Set lifecycle policy (`{ prefix?, expireAfterDays?, transitionToColdAfterDays? }`) |

### Objects
| Method | Path | Description |
|---|---|---|
| `PUT` | `/buckets/:b/objects/:key` | Upload object |
| `GET` | `/buckets/:b/objects/:key` | Download object |
| `GET` | `/buckets/:b/objects/:key?versionId=X` | Download specific version |
| `GET` | `/buckets/:b/objects/:key?versions` | List version history |
| `GET` | `/buckets/:b/objects/:key` + `Range: bytes=S-E` | Range request → 206 |
| `PUT` | `/buckets/:b/objects/:key?versionId=X&restore=true` | Restore old version |
| `DELETE` | `/buckets/:b/objects/:key` | Soft-delete (inserts delete marker) |
| `HEAD` | `/buckets/:b/objects/:key` | Metadata only |

**Multipart:**
| Method | Path | Description |
|---|---|---|
| `POST` | `/buckets/:b/objects/:key?uploads` | Initiate multipart upload |
| `PUT` | `/buckets/:b/objects/:key?uploadId=X&partNumber=N` | Upload part |
| `POST` | `/buckets/:b/objects/:key?uploadId=X` | Complete multipart upload |
| `DELETE` | `/buckets/:b/objects/:key?uploadId=X` | Abort multipart upload |

### Auth
| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/keys` | Create access key (`{ ownerId? }` → `{ accessKeyId, rawSecret }`) |
| `GET` | `/presign?bucket=&key=&method=&expires=&accessKeyId=&secret=` | Generate presigned URL |

### Admin
| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/buckets` | All bucket stats |
| `GET` | `/admin/buckets/:name/stats` | Single bucket stats |
| `GET` | `/admin/nodes` | Storage node health + replica counts |
| `GET` | `/admin/gc/stats` | GC stats (total chunks, orphaned, bytes) |

## Load Testing (Phase 8)

```bash
# Install k6: https://k6.io/docs/getting-started/installation/
k6 run k6/load-test.js

# Against a remote target
API_URL=http://your-server:3000 k6 run k6/load-test.js
```

**Targets:** p95 PUT < 200 ms, p95 GET < 200 ms, throughput ≥ 100 req/s at 50 VUs.

## Project Structure

```
.
├── apps/
│   ├── api/              # NestJS API (port 3000)
│   │   ├── src/
│   │   │   ├── auth/           # Access keys, HMAC presigned URLs
│   │   │   ├── admin/          # Analytics and observability endpoints
│   │   │   ├── bandwidth/      # Token-bucket rate limiting interceptor
│   │   │   ├── buckets/        # Bucket CRUD, versioning, lifecycle config
│   │   │   ├── database/       # pg Pool global module
│   │   │   ├── health/         # /health endpoint
│   │   │   ├── multipart/      # Multipart upload coordination
│   │   │   ├── objects/        # Object PUT/GET/DELETE/Range
│   │   │   ├── redis/          # ioredis global module
│   │   │   └── storage/
│   │   │       ├── chunk.service.ts   # Dedup, quorum writes, hot cache
│   │   │       ├── ring.service.ts    # Consistent hash ring (Redis-cached)
│   │   │       └── storage.service.ts # Per-node S3 clients
│   │   └── test/         # Integration tests (phases 1–5)
│   ├── admin-console/    # Next.js admin UI (port 3001)
│   └── worker/           # BullMQ: anti-entropy, GC, lifecycle
├── infra/
│   ├── docker-compose.yml
│   └── migrations/       # PostgreSQL DDL + seed data
├── k6/
│   └── load-test.js      # k6 load test (Phase 8)
└── packages/
    ├── hash-ring/        # Consistent hash ring library (SHA-1, virtual nodes)
    ├── sdk/              # Client SDK
    └── shared-types/     # Shared TypeScript types
```

## Phases Completed

| Phase | Feature | Status |
|---|---|---|
| 1 | Core API: buckets, single-shot PUT/GET/DELETE, chunking, dedup | ✅ |
| 2 | Multipart uploads (parallel parts, manifest assembly) | ✅ |
| 3 | 5-node hash ring, RF=3 replication, W=2 quorum, read repair, anti-entropy | ✅ |
| 4 | Versioning, delete markers, restore, range requests, GC worker | ✅ |
| 5 | HMAC-SHA256 presigned URLs, access key auth, bucket config API | ✅ |
| 6 | Hot-chunk Redis cache, token-bucket bandwidth throttling | ✅ |
| 7 | Lifecycle policies, admin console (Next.js), BullMQ lifecycle worker | ✅ |
| 8 | k6 load tests, README, DECISIONS.md | ✅ |

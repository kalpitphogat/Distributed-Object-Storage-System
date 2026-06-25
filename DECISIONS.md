# DECISIONS.md

Deviations from the build plan and key architectural decisions, logged for interview prep.

| # | Decision | Deviation | Reason |
|---|----------|-----------|--------|
| 1 | Package manager | Used **pnpm** (not npm/yarn) | pnpm workspaces are first-class for monorepos and use hard-links to save disk space; all plan choices (NestJS, BullMQ, etc.) are unaffected |
| 2 | Phase 0 MinIO count | Started with **1** MinIO container (not 5) | Plan §14 says "1 MinIO to start" for Phase 0; remaining 4 added in Phase 3 when replication is implemented |
| 3 | Database migration tool | Used **node-pg-migrate** with raw SQL files | Plan §5 explicitly lists node-pg-migrate; raw SQL matches the DDL in §6 exactly and is the most transparent for interview review |
| 4 | Raw secret storage | `raw_secret` column on `access_keys` | HMAC verification requires the raw secret; bcrypt is one-way so re-derivation is impossible. Production would use KMS envelope encryption. |
| 5 | Global body parsing | `express.raw({ type: '*/*' })` for all routes | Binary object uploads must not be JSON-parsed; all routes receive a Buffer and JSON routes parse manually. Consistent and explicit. |
| 6 | Ring cache in Redis | 5-minute TTL snapshot | All API pods need the same ring; Redis is the shared coordination point. Shorter TTL or pub/sub invalidation could reduce stale-ring window. |
| 7 | Chunk key format | `sha256/{h[0:2]}/{h[2:4]}/{h}` | Two-level hex prefix forces even shard distribution in MinIO; mirrors Git object store pattern. |
| 8 | Delete markers | Soft delete via version row | S3 versioning semantics; allows zero-copy restore. GC and explicit version pruning reclaim storage. |
| 9 | ref_count starts at 0 | Chunk row inserted before manifest commit | Crash safety: if the manifest transaction rolls back, the chunk has ref_count=0 and GC reclaims it after the 1-hour grace period. |
| 10 | Admin console dynamic pages | `export const dynamic = 'force-dynamic'` | Build-time pre-rendering would fail (API not available during `docker build`); admin pages always show live data. |
| 11 | Worker CommonJS | No top-level await; all init in `async main()` | `"module": "CommonJS"` in tsconfig.json doesn't support top-level `await`. BullMQ v5 removed `QueueScheduler`. |
| 12 | pnpm CLI globals | `npm install -g @nestjs/cli typescript` in Dockerfiles | Node.js v22 Alpine can't resolve pnpm virtual-store symlinks as main-module entry points; global install avoids the issue. Admin-console uses plain `npm install`. |

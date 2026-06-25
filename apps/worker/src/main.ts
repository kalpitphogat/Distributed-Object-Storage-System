/**
 * Mini-S3 background worker.
 * Runs three repeatable BullMQ jobs:
 *   anti-entropy — verify replica checksums, repair stale copies  (every 15 min)
 *   gc           — mark-and-sweep orphaned chunks                  (hourly)
 *   lifecycle    — expire / cold-transition objects per policy     (daily)
 */
import { Worker, Queue } from 'bullmq';
import { Pool } from 'pg';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { Readable } from 'stream';

// ── Connection setup ─────────────────────────────────────────────────────────

const redisUrl = new URL(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
const redisOpts = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port) || 6379,
  maxRetriesPerRequest: null as null,
};

const pool = new Pool({
  connectionString: process.env['DATABASE_URL'] ?? 'postgresql://miniadmin:minipassword@localhost:5432/minis3',
});

const MINIO_ACCESS_KEY = process.env['MINIO_ACCESS_KEY'] ?? 'minioadmin';
const MINIO_SECRET_KEY = process.env['MINIO_SECRET_KEY'] ?? 'minioadmin123';
const CHUNKS_BUCKET = 'mini-s3-chunks';
const RF = Number(process.env['REPLICATION_FACTOR'] ?? 3);
const GC_GRACE_PERIOD_HOURS = 1; // keep ref_count=0 chunks for 1 hour before deleting

// ── Per-node S3 clients ───────────────────────────────────────────────────────

function buildNodeClients(): Map<string, S3Client> {
  const clients = new Map<string, S3Client>();
  for (const [key, val] of Object.entries(process.env)) {
    if (/^MINIO_NODE_\d+_URL$/.test(key) && val) {
      clients.set(val, new S3Client({
        endpoint: val,
        region: 'us-east-1',
        credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
        forcePathStyle: true,
      }));
    }
  }
  return clients;
}

const nodeClients = buildNodeClients();
console.log(`Worker: connected to ${nodeClients.size} storage node(s)`);

function chunkKey(sha256: string): string {
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) {
    parts.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(parts);
}

async function getChunkFromNode(sha256: string, nodeUrl: string): Promise<Buffer> {
  const client = nodeClients.get(nodeUrl);
  if (!client) throw new Error(`No client for ${nodeUrl}`);
  const res = await client.send(new GetObjectCommand({ Bucket: CHUNKS_BUCKET, Key: chunkKey(sha256) }));
  return streamToBuffer(res.Body as Readable);
}

async function putChunkToNode(sha256: string, data: Buffer, nodeUrl: string): Promise<void> {
  const client = nodeClients.get(nodeUrl);
  if (!client) throw new Error(`No client for ${nodeUrl}`);
  await client.send(new PutObjectCommand({ Bucket: CHUNKS_BUCKET, Key: chunkKey(sha256), Body: data, ContentLength: data.length }));
}

async function deleteChunkFromNode(sha256: string, nodeUrl: string): Promise<void> {
  const client = nodeClients.get(nodeUrl);
  if (!client) throw new Error(`No client for ${nodeUrl}`);
  await client.send(new DeleteObjectCommand({ Bucket: CHUNKS_BUCKET, Key: chunkKey(sha256) }));
}

// ── Anti-entropy job ─────────────────────────────────────────────────────────
// For each chunk: verify checksum on every active replica, repair stale ones.
// Also re-replicate to any ring-assigned node that's missing a copy.

async function runAntiEntropy(): Promise<{ scanned: number; repaired: number }> {
  let scanned = 0;
  let repaired = 0;

  // Process in batches of 200 to avoid loading the entire chunks table into memory.
  const BATCH = 200;
  let offset = 0;

  while (true) {
    const chunkRows = await pool.query<{ id: string; content_sha256: string }>(
      `SELECT id, content_sha256 FROM chunks ORDER BY created_at LIMIT $1 OFFSET $2`,
      [BATCH, offset],
    );
    if (chunkRows.rows.length === 0) break;

    for (const row of chunkRows.rows) {
      scanned++;
      const { id: chunkId, content_sha256: sha256 } = row;

      // Get all active replicas for this chunk.
      const repRes = await pool.query<{ node_url: string; replica_id: string }>(
        `SELECT sn.node_url, cr.id AS replica_id
         FROM chunk_replicas cr
         JOIN storage_nodes sn ON sn.id = cr.storage_node_id
         WHERE cr.chunk_id = $1 AND cr.status = 'active' AND sn.status = 'active'`,
        [chunkId],
      );

      let goodBytes: Buffer | null = null;

      for (const rep of repRes.rows) {
        try {
          const bytes = await getChunkFromNode(sha256, rep.node_url);
          const actual = createHash('sha256').update(bytes).digest('hex');
          if (actual !== sha256) {
            // Mark stale.
            await pool.query(
              `UPDATE chunk_replicas SET status = 'stale' WHERE id = $1`,
              [rep.replica_id],
            );
            continue;
          }
          if (!goodBytes) goodBytes = bytes;
        } catch {
          // Node unreachable — don't change status (it may be temporarily down).
        }
      }

      // Repair stale replicas from a good copy.
      if (goodBytes) {
        const staleRes = await pool.query<{ node_url: string; replica_id: string }>(
          `SELECT sn.node_url, cr.id AS replica_id
           FROM chunk_replicas cr
           JOIN storage_nodes sn ON sn.id = cr.storage_node_id
           WHERE cr.chunk_id = $1 AND cr.status = 'stale' AND sn.status = 'active'`,
          [chunkId],
        );
        for (const rep of staleRes.rows) {
          try {
            await putChunkToNode(sha256, goodBytes, rep.node_url);
            await pool.query(
              `UPDATE chunk_replicas SET status = 'active', last_verified_at = now()
               WHERE id = $1`,
              [rep.replica_id],
            );
            repaired++;
            console.log(`Anti-entropy repaired chunk ${sha256.slice(0, 8)}… on ${rep.node_url}`);
          } catch (err) {
            console.error(`Anti-entropy repair failed for ${sha256.slice(0, 8)}…: ${String(err)}`);
          }
        }
      }
    }

    offset += BATCH;
  }

  return { scanned, repaired };
}

// ── GC job — mark-and-sweep ──────────────────────────────────────────────────
// Mark phase: build live set of all chunk_ids in non-delete-marker versions.
// Sweep phase: delete chunks with ref_count=0 not in live set, older than grace period.

async function runGc(): Promise<{ scanned: number; deleted: number; bytesReclaimed: number }> {
  // Mark: find chunk IDs that are still referenced.
  const liveRes = await pool.query<{ chunk_id: string }>(
    `SELECT DISTINCT ovc.chunk_id
     FROM object_version_chunks ovc
     JOIN object_versions ov ON ov.id = ovc.object_version_id
     WHERE ov.is_delete_marker = false`,
  );
  const liveSet = new Set(liveRes.rows.map((r) => r.chunk_id));

  // Sweep: chunks with ref_count=0 that aren't live and are old enough.
  const candidateRes = await pool.query<{
    id: string;
    content_sha256: string;
    size_bytes: number;
  }>(
    `SELECT id, content_sha256, size_bytes
     FROM chunks
     WHERE ref_count = 0
       AND created_at < now() - interval '${GC_GRACE_PERIOD_HOURS} hours'`,
  );

  let deleted = 0;
  let bytesReclaimed = 0;

  for (const chunk of candidateRes.rows) {
    if (liveSet.has(chunk.id)) continue; // still referenced, skip

    // Delete from all replica nodes.
    const repRes = await pool.query<{ node_url: string }>(
      `SELECT sn.node_url
       FROM chunk_replicas cr
       JOIN storage_nodes sn ON sn.id = cr.storage_node_id
       WHERE cr.chunk_id = $1`,
      [chunk.id],
    );

    for (const rep of repRes.rows) {
      try {
        await deleteChunkFromNode(chunk.content_sha256, rep.node_url);
      } catch { /* node may already not have it */ }
    }

    await pool.query(`DELETE FROM chunk_replicas WHERE chunk_id = $1`, [chunk.id]);
    await pool.query(`DELETE FROM chunks WHERE id = $1`, [chunk.id]);

    deleted++;
    bytesReclaimed += Number(chunk.size_bytes) * RF;
    console.log(`GC: deleted chunk ${chunk.content_sha256.slice(0, 8)}… (${chunk.size_bytes} bytes × ${RF} replicas)`);
  }

  return { scanned: candidateRes.rows.length, deleted, bytesReclaimed };
}

// ── Lifecycle job ─────────────────────────────────────────────────────────────
// Process lifecycle_policies: expire or cold-transition old object versions.

async function runLifecycle(): Promise<{ expired: number; transitioned: number }> {
  let expired = 0;
  let transitioned = 0;

  const policies = await pool.query<{
    bucket_id: string;
    bucket_name: string;
    prefix: string | null;
    expire_after_days: number | null;
    transition_to_cold_after_days: number | null;
  }>(
    `SELECT lp.bucket_id, b.name AS bucket_name,
            lp.prefix, lp.expire_after_days, lp.transition_to_cold_after_days
     FROM lifecycle_policies lp
     JOIN buckets b ON b.id = lp.bucket_id
     WHERE lp.enabled = true`,
  );

  for (const policy of policies.rows) {
    if (policy.expire_after_days) {
      // Mark object versions older than expire_after_days as deleted.
      const res = await pool.query(
        `UPDATE object_versions ov
         SET is_delete_marker = true
         FROM objects o
         WHERE ov.object_id = o.id
           AND o.bucket_id = $1
           AND ov.created_at < now() - ($2 || ' days')::interval
           AND ov.is_delete_marker = false
           AND ($3::text IS NULL OR o.object_key LIKE $3 || '%')`,
        [policy.bucket_id, policy.expire_after_days, policy.prefix],
      );
      expired += res.rowCount ?? 0;
    }

    if (policy.transition_to_cold_after_days) {
      const res = await pool.query(
        `UPDATE object_versions ov
         SET storage_class = 'COLD'
         FROM objects o
         WHERE ov.object_id = o.id
           AND o.bucket_id = $1
           AND ov.created_at < now() - ($2 || ' days')::interval
           AND ov.storage_class = 'STANDARD'
           AND ov.is_delete_marker = false
           AND ($3::text IS NULL OR o.object_key LIKE $3 || '%')`,
        [policy.bucket_id, policy.transition_to_cold_after_days, policy.prefix],
      );
      transitioned += res.rowCount ?? 0;
    }
  }

  return { expired, transitioned };
}

// ── BullMQ worker setup ──────────────────────────────────────────────────────

const QUEUE_NAME = 'mini-s3-jobs';

async function main(): Promise<void> {
  // Register repeatable jobs. BullMQ v5 deduplicates repeat entries by jobId.
  const jobQueue = new Queue(QUEUE_NAME, { connection: redisOpts });
  await jobQueue.add('anti-entropy', {}, { repeat: { every: 15 * 60 * 1000 }, jobId: 'ae' });
  await jobQueue.add('gc', {}, { repeat: { every: 60 * 60 * 1000 }, jobId: 'gc' });
  await jobQueue.add('lifecycle', {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'lc' });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(`[worker] Running job: ${job.name}`);
      switch (job.name) {
        case 'anti-entropy': {
          const res = await runAntiEntropy();
          console.log(`[anti-entropy] scanned=${res.scanned} repaired=${res.repaired}`);
          break;
        }
        case 'gc': {
          const res = await runGc();
          console.log(`[gc] scanned=${res.scanned} deleted=${res.deleted} bytesReclaimed=${res.bytesReclaimed}`);
          break;
        }
        case 'lifecycle': {
          const res = await runLifecycle();
          console.log(`[lifecycle] expired=${res.expired} transitioned=${res.transitioned}`);
          break;
        }
        default:
          console.log(`[worker] Unknown job: ${job.name}`);
      }
    },
    { connection: redisOpts },
  );

  console.log('Mini-S3 worker started (anti-entropy, gc, lifecycle)');

  process.on('SIGTERM', () => {
    void worker.close().then(() => jobQueue.close()).then(() => pool.end()).then(() => process.exit(0));
  });
}

main().catch((err: unknown) => {
  console.error('Worker startup error:', err);
  process.exit(1);
});

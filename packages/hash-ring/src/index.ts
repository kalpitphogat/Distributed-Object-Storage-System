import { createHash } from 'crypto';

// Maps a string key to a 32-bit unsigned integer position on the ring [0, 2^32).
// SHA-1 output is 20 bytes; we take the first 4 as a big-endian uint32.
// SHA-1 is intentional here: we need uniform distribution, not collision resistance,
// and SHA-1 is faster than SHA-256 for this hot path.
function hashToPosition(key: string): number {
  const digest = createHash('sha1').update(key).digest();
  return digest.readUInt32BE(0);
}

// Returns the index of the first element in the sorted array whose position
// is >= target, wrapping around to 0 if no such element exists.
// O(log n) binary search — the ring can have thousands of virtual nodes.
function binarySearchFirstGTE(
  ring: RingEntry[],
  target: number,
): number {
  let lo = 0;
  let hi = ring.length - 1;
  let result = 0; // default: wrap around to start

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (ring[mid]!.position >= target) {
      result = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return result;
}

interface RingEntry {
  position: number;
  nodeId: string;
}

/**
 * Consistent hash ring with virtual nodes.
 *
 * WHY VIRTUAL NODES: each physical node gets `virtualNodeCount` positions on
 * the ring instead of one. When a node is added or removed, only ~1/(N+1) of
 * the keyspace is reassigned instead of ~1/N chunks jumping to a single
 * neighbor. More virtual nodes = smoother load distribution but more memory.
 * 150 is the default used by Apache Cassandra.
 */
export class HashRing {
  private ring: RingEntry[] = [];
  private readonly virtualNodeCount: number;

  constructor(virtualNodeCount = 150) {
    this.virtualNodeCount = virtualNodeCount;
  }

  addNode(nodeId: string, virtualNodes?: number): void {
    const count = virtualNodes ?? this.virtualNodeCount;
    for (let i = 0; i < count; i++) {
      this.ring.push({
        position: hashToPosition(`${nodeId}:${i}`),
        nodeId,
      });
    }
    // Keep ring sorted so binary search stays valid.
    this.ring.sort((a, b) => a.position - b.position);
  }

  removeNode(nodeId: string): void {
    this.ring = this.ring.filter((e) => e.nodeId !== nodeId);
  }

  /**
   * Walk clockwise from hash(key), collecting `count` distinct physical nodes.
   * Skips virtual nodes that map to an already-selected physical node so that
   * two replicas never land on the same machine.
   */
  getReplicaNodes(key: string, count: number): string[] {
    if (this.ring.length === 0) return [];

    const distinctNodes = new Set(this.ring.map((e) => e.nodeId));
    const clampedCount = Math.min(count, distinctNodes.size);

    const target = hashToPosition(key);
    const startIdx = binarySearchFirstGTE(this.ring, target);

    const result: string[] = [];
    for (
      let i = 0;
      i < this.ring.length && result.length < clampedCount;
      i++
    ) {
      const candidate = this.ring[(startIdx + i) % this.ring.length]!.nodeId;
      if (!result.includes(candidate)) {
        result.push(candidate);
      }
    }
    return result;
  }

  /** Total virtual node slots currently on the ring. */
  get size(): number {
    return this.ring.length;
  }

  /** Number of distinct physical nodes. */
  get nodeCount(): number {
    return new Set(this.ring.map((e) => e.nodeId)).size;
  }

  /**
   * Returns a snapshot suitable for caching in Redis.
   * The ring is just a sorted array, so JSON serialization is cheap.
   */
  serialize(): string {
    return JSON.stringify(this.ring);
  }

  static deserialize(json: string): HashRing {
    const hr = new HashRing();
    hr.ring = JSON.parse(json) as RingEntry[];
    return hr;
  }
}

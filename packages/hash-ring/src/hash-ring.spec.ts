import { HashRing } from './index';

describe('HashRing', () => {
  describe('basic operations', () => {
    it('returns empty array when ring is empty', () => {
      const ring = new HashRing();
      expect(ring.getReplicaNodes('any-key', 3)).toEqual([]);
    });

    it('returns the only node when ring has one node', () => {
      const ring = new HashRing();
      ring.addNode('node-1');
      expect(ring.getReplicaNodes('any-key', 3)).toEqual(['node-1']);
    });

    it('returns at most count distinct nodes', () => {
      const ring = new HashRing();
      ring.addNode('node-1');
      ring.addNode('node-2');
      const replicas = ring.getReplicaNodes('key', 3);
      // only 2 physical nodes exist, so max 2 returned
      expect(replicas.length).toBe(2);
    });

    it('never returns duplicate physical nodes in replica set', () => {
      const ring = new HashRing();
      ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'].forEach((n) =>
        ring.addNode(n),
      );
      for (let i = 0; i < 100; i++) {
        const replicas = ring.getReplicaNodes(`key-${i}`, 3);
        const unique = new Set(replicas);
        expect(unique.size).toBe(replicas.length);
      }
    });

    it('removes a node and stops assigning it', () => {
      const ring = new HashRing();
      ring.addNode('node-1');
      ring.addNode('node-2');
      ring.addNode('node-3');
      ring.removeNode('node-2');

      for (let i = 0; i < 50; i++) {
        const replicas = ring.getReplicaNodes(`key-${i}`, 3);
        expect(replicas).not.toContain('node-2');
      }
    });
  });

  describe('load distribution', () => {
    it('distributes keys roughly evenly across nodes (±30% tolerance)', () => {
      const ring = new HashRing(150);
      const nodes = ['node-1', 'node-2', 'node-3', 'node-4', 'node-5'];
      nodes.forEach((n) => ring.addNode(n));

      const counts: Record<string, number> = {};
      nodes.forEach((n) => (counts[n] = 0));

      const KEYS = 10_000;
      for (let i = 0; i < KEYS; i++) {
        // primary replica is always the first returned node
        const primary = ring.getReplicaNodes(`object-${i}`, 1)[0]!;
        counts[primary]++;
      }

      const expected = KEYS / nodes.length;
      for (const node of nodes) {
        const ratio = counts[node]! / expected;
        // each node should own between 70% and 130% of the ideal share
        expect(ratio).toBeGreaterThan(0.7);
        expect(ratio).toBeLessThan(1.3);
      }
    });
  });

  describe('stability under node changes', () => {
    it('reassigns only ~1/N keys when a new node is added', () => {
      const ring = new HashRing(150);
      const nodes = ['node-1', 'node-2', 'node-3', 'node-4'];
      nodes.forEach((n) => ring.addNode(n));

      const KEYS = 10_000;
      const before: string[] = [];
      for (let i = 0; i < KEYS; i++) {
        before.push(ring.getReplicaNodes(`key-${i}`, 1)[0]!);
      }

      ring.addNode('node-5'); // 5 nodes total, ~1/5 keys should move

      let moved = 0;
      for (let i = 0; i < KEYS; i++) {
        const after = ring.getReplicaNodes(`key-${i}`, 1)[0]!;
        if (after !== before[i]) moved++;
      }

      const movedFraction = moved / KEYS;
      // Ideal is 1/5 = 0.20; allow generous range due to hash variance
      expect(movedFraction).toBeGreaterThan(0.1);
      expect(movedFraction).toBeLessThan(0.35);
    });
  });

  describe('serialization', () => {
    it('round-trips through serialize/deserialize', () => {
      const ring = new HashRing();
      ['a', 'b', 'c'].forEach((n) => ring.addNode(n));

      const restored = HashRing.deserialize(ring.serialize());

      for (let i = 0; i < 100; i++) {
        expect(restored.getReplicaNodes(`k-${i}`, 3)).toEqual(
          ring.getReplicaNodes(`k-${i}`, 3),
        );
      }
    });
  });
});

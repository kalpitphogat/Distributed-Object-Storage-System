// Shared domain types used by api, worker, and sdk

export interface Bucket {
  id: string;
  name: string;
  ownerId: string;
  versioningEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ObjectVersion {
  id: string;
  objectId: string;
  versionNumber: number;
  sizeBytes: number;
  contentSha256: string | null;
  etag: string;
  isDeleteMarker: boolean;
  storageClass: 'STANDARD' | 'COLD';
  createdAt: Date;
}

export interface ChunkRef {
  id: string;
  contentSha256: string;
  sizeBytes: number;
  refCount: number;
}

export interface ChunkManifestEntry {
  index: number;
  hash: string;
  sizeBytes: number;
  byteOffset: number;
}

export interface ObjectManifest {
  objectVersionId: string;
  sizeBytes: number;
  chunks: ChunkManifestEntry[];
}

export interface StorageNode {
  id: string;
  nodeUrl: string;
  status: 'active' | 'draining' | 'down';
  capacityBytes: number;
  usedBytes: number;
  virtualNodeCount: number;
  lastHeartbeatAt: Date | null;
}

export const REPLICATION_FACTOR = 3;
export const WRITE_QUORUM = 2;
export const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB per plan §7.2

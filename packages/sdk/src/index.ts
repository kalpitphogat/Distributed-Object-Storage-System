// Thin client for Mini-S3 API — built out fully in Phase 5
// Stub here so the package exists in the workspace from day one.

export interface MiniS3ClientConfig {
  endpoint: string;
  accessKeyId: string;
  secretKey: string;
}

export class MiniS3Client {
  constructor(private readonly config: MiniS3ClientConfig) {}

  getEndpoint(): string {
    return this.config.endpoint;
  }
}

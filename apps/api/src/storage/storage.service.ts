import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  GetObjectCommandInput,
  HeadBucketCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Readable } from 'stream';

/**
 * Manages one S3Client per storage node.
 * Knows nothing about the hash ring — that's RingService's job.
 * ChunkService orchestrates which nodes to use for each chunk.
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly clients = new Map<string, S3Client>(); // nodeUrl → S3Client
  private readonly CHUNKS_BUCKET = 'mini-s3-chunks';
  private readonly creds: { accessKeyId: string; secretAccessKey: string };

  constructor() {
    this.creds = {
      accessKeyId: process.env['MINIO_ACCESS_KEY'] ?? 'minioadmin',
      secretAccessKey: process.env['MINIO_SECRET_KEY'] ?? 'minioadmin123',
    };
  }

  async onModuleInit(): Promise<void> {
    const urls = this.nodeUrls();
    for (const url of urls) {
      const client = new S3Client({
        endpoint: url,
        region: 'us-east-1',
        credentials: this.creds,
        forcePathStyle: true,
      });
      this.clients.set(url, client);
      await this.ensureBucket(client).catch((err: unknown) => {
        this.logger.warn(`Could not init bucket on ${url}: ${String(err)}`);
      });
    }
    this.logger.log(`StorageService: initialized ${this.clients.size} node client(s)`);
  }

  /** All node URLs derived from MINIO_NODE_*_URL environment variables. */
  nodeUrls(): string[] {
    return Object.entries(process.env)
      .filter(([k]) => /^MINIO_NODE_\d+_URL$/.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v as string)
      .filter(Boolean);
  }

  async putChunkToNode(sha256: string, data: Buffer, nodeUrl: string): Promise<void> {
    const client = this.getClient(nodeUrl);
    await client.send(
      new PutObjectCommand({
        Bucket: this.CHUNKS_BUCKET,
        Key: this.chunkKey(sha256),
        Body: data,
        ContentLength: data.length,
      }),
    );
  }

  async getChunkFromNode(sha256: string, nodeUrl: string): Promise<Buffer> {
    const client = this.getClient(nodeUrl);
    const res = await client.send(
      new GetObjectCommand({
        Bucket: this.CHUNKS_BUCKET,
        Key: this.chunkKey(sha256),
      }),
    );
    return this.streamToBuffer(res.Body as Readable);
  }

  /** GET a byte range from a single chunk on a specific node. Used for Range requests. */
  async getChunkRangeFromNode(
    sha256: string,
    nodeUrl: string,
    byteStart: number,
    byteEnd: number,
  ): Promise<Buffer> {
    const client = this.getClient(nodeUrl);
    const input: GetObjectCommandInput = {
      Bucket: this.CHUNKS_BUCKET,
      Key: this.chunkKey(sha256),
      Range: `bytes=${byteStart}-${byteEnd}`,
    };
    const res = await client.send(new GetObjectCommand(input));
    return this.streamToBuffer(res.Body as Readable);
  }

  async deleteChunkFromNode(sha256: string, nodeUrl: string): Promise<void> {
    const client = this.getClient(nodeUrl);
    await client.send(
      new DeleteObjectCommand({
        Bucket: this.CHUNKS_BUCKET,
        Key: this.chunkKey(sha256),
      }),
    );
  }

  private getClient(nodeUrl: string): S3Client {
    const client = this.clients.get(nodeUrl);
    if (!client) throw new Error(`No S3 client registered for node ${nodeUrl}`);
    return client;
  }

  // Two-level prefix prevents MinIO flat-namespace performance issues on large chunk counts.
  // Pattern from §7.1: sha256/{hash[0:2]}/{hash[2:4]}/{hash}
  chunkKey(sha256: string): string {
    return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  }

  private async ensureBucket(client: S3Client): Promise<void> {
    try {
      await client.send(new HeadBucketCommand({ Bucket: this.CHUNKS_BUCKET }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: this.CHUNKS_BUCKET }));
    }
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const parts: Uint8Array[] = [];
    for await (const chunk of stream) {
      parts.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(parts);
  }
}

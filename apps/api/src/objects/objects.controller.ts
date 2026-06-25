import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Head,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ObjectsService } from './objects.service';
import { MultipartService, PartInput } from '../multipart/multipart.service';
import { AuthService } from '../auth/auth.service';

@Controller('buckets/:bucketName/objects')
export class ObjectsController {
  constructor(
    private readonly objectsSvc: ObjectsService,
    private readonly multipartSvc: MultipartService,
    private readonly authSvc: AuthService,
  ) {}

  // ── PUT /buckets/:bucketName/objects/<key> ────────────────────────────────
  //   No query params         → single-shot upload
  //   ?uploadId=X&partNumber=N → upload one multipart part
  //   ?versionId=X&restore=true → restore a specific version
  @Put('*')
  @HttpCode(200)
  async putObject(
    @Param('bucketName') bucketName: string,
    @Query('uploadId') uploadId: string | undefined,
    @Query('partNumber') partNumberStr: string | undefined,
    @Query('versionId') versionId: string | undefined,
    @Query('restore') restore: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<
    | { etag: string; sizeBytes: number; versionId: string }
    | { etag: string; partNumber: number }
  > {
    const key = this.extractKey(req.originalUrl, bucketName);

    if (restore !== undefined && versionId) {
      const result = await this.objectsSvc.restoreVersion(bucketName, key, versionId);
      res.set('ETag', `"${result.etag}"`);
      return result;
    }

    const body = req.body as Buffer;

    if (uploadId !== undefined && partNumberStr !== undefined) {
      const partNumber = parseInt(partNumberStr, 10);
      if (isNaN(partNumber) || partNumber < 1) {
        throw new BadRequestException('partNumber must be a positive integer');
      }
      const result = await this.multipartSvc.uploadPart(uploadId, partNumber, body);
      res.set('ETag', `"${result.etag}"`);
      return result;
    }

    const result = await this.objectsSvc.put(bucketName, key, body);
    res.set('ETag', `"${result.etag}"`);
    res.set('x-mini-s3-version-id', result.versionId);
    return result;
  }

  // ── GET /buckets/:bucketName/objects/<key> ────────────────────────────────
  //   Range: bytes=start-end → 206 Partial Content
  //   ?versionId=X           → specific version
  //   ?versions              → version history list
  //   ?Expires=&AccessKeyId=&Signature= → presigned URL access
  @Get('*')
  async getObject(
    @Param('bucketName') bucketName: string,
    @Query('versionId') versionId: string | undefined,
    @Query('versions') versions: string | undefined,
    @Query('Expires') presignExpires: string | undefined,
    @Query('AccessKeyId') presignKeyId: string | undefined,
    @Query('Signature') presignSig: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | object[]> {
    const key = this.extractKey(req.originalUrl, bucketName);

    // Presigned URL — verify signature before proceeding.
    if (presignSig !== undefined) {
      if (!presignExpires || !presignKeyId) {
        throw new ForbiddenException('Invalid presigned URL: missing parameters');
      }
      const valid = await this.authSvc.verifyPresignedUrl(
        'GET',
        bucketName,
        key,
        presignExpires,
        presignKeyId,
        presignSig,
      );
      if (!valid) throw new ForbiddenException('Presigned URL is invalid or has expired');
    }

    // ?versions → return version history as JSON
    if (versions !== undefined) {
      return this.objectsSvc.listVersions(bucketName, key);
    }

    const rangeHeader = req.headers['range'];

    if (rangeHeader) {
      // First fetch size metadata to parse the range.
      const objResult = await this.objectsSvc.get(bucketName, key, versionId);
      const range = ObjectsService.parseRange(rangeHeader, objResult.sizeBytes);
      if (!range) {
        res.status(416);
        res.set('Content-Range', `bytes */${objResult.sizeBytes}`);
        return new StreamableFile(Buffer.alloc(0));
      }

      const rangeResult = await this.objectsSvc.getRange(bucketName, key, range.start, range.end);
      res.status(206);
      res.set('Content-Range', `bytes ${range.start}-${range.end}/${objResult.sizeBytes}`);
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Length', String(rangeResult.data.length));
      res.set('ETag', `"${rangeResult.etag}"`);
      return new StreamableFile(rangeResult.data, { type: 'application/octet-stream' });
    }

    const result = await this.objectsSvc.get(bucketName, key, versionId);
    res.set('ETag', `"${result.etag}"`);
    res.set('Content-SHA256', result.contentSha256);
    res.set('Content-Length', String(result.sizeBytes));
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('x-mini-s3-version-id', result.versionId);
    return new StreamableFile(result.data, { type: 'application/octet-stream' });
  }

  // ── HEAD /buckets/:bucketName/objects/<key> ───────────────────────────────
  @Head('*')
  @HttpCode(200)
  async headObject(
    @Param('bucketName') bucketName: string,
    @Query('versionId') versionId: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const key = this.extractKey(req.originalUrl, bucketName);
    const result = await this.objectsSvc.get(bucketName, key, versionId);
    res.set('ETag', `"${result.etag}"`);
    res.set('Content-Length', String(result.sizeBytes));
    res.set('Content-SHA256', result.contentSha256);
    res.set('Accept-Ranges', 'bytes');
    res.set('x-mini-s3-version-id', result.versionId);
  }

  // ── POST /buckets/:bucketName/objects/<key> ───────────────────────────────
  //   ?uploads    → initiate multipart upload
  //   ?uploadId=X → complete multipart upload
  @Post('*')
  async postObject(
    @Param('bucketName') bucketName: string,
    @Query('uploads') uploads: string | undefined,
    @Query('uploadId') uploadId: string | undefined,
    @Req() req: Request,
  ): Promise<{ uploadId: string } | { etag: string; sizeBytes: number }> {
    const key = this.extractKey(req.originalUrl, bucketName);

    if (uploads !== undefined) {
      return this.multipartSvc.initiate(bucketName, key);
    }

    if (uploadId !== undefined) {
      const body = req.body as Buffer;
      const parsed = JSON.parse(body.toString('utf-8')) as { parts: PartInput[] };
      return this.multipartSvc.complete(bucketName, key, uploadId, parsed.parts);
    }

    throw new BadRequestException(
      'POST to an object key requires either ?uploads or ?uploadId query parameter',
    );
  }

  // ── DELETE /buckets/:bucketName/objects/<key> ─────────────────────────────
  //   ?uploadId=X → abort multipart upload (returns 204)
  //   (no params) → soft-delete the object (inserts delete marker, returns 204)
  @Delete('*')
  @HttpCode(204)
  async deleteObject(
    @Param('bucketName') bucketName: string,
    @Query('uploadId') uploadId: string | undefined,
    @Req() req: Request,
  ): Promise<void> {
    if (uploadId !== undefined) {
      return this.multipartSvc.abort(uploadId);
    }
    const key = this.extractKey(req.originalUrl, bucketName);
    return this.objectsSvc.deleteObject(bucketName, key);
  }

  /**
   * Extract the object key from the full request URL.
   * Uses req.originalUrl (always the root-relative path) rather than req.path
   * so that deeply-nested keys (a/b/c/d.bin) survive Express router stripping.
   */
  private extractKey(originalUrl: string, bucketName: string): string {
    const prefix = `/buckets/${bucketName}/objects/`;
    const pathOnly = originalUrl.split('?')[0];
    const idx = pathOnly.indexOf(prefix);
    const raw = idx >= 0 ? pathOnly.slice(idx + prefix.length) : pathOnly;
    return decodeURIComponent(raw);
  }
}

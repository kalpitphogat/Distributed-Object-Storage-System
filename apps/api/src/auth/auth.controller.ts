import {
  Controller,
  HttpCode,
  Post,
  Get,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';

@Controller()
export class AuthController {
  constructor(private readonly authSvc: AuthService) {}

  /** POST /auth/keys — create a new access key pair. */
  @Post('auth/keys')
  @HttpCode(201)
  async createKey(
    @Req() req: Request,
  ): Promise<{ accessKeyId: string; rawSecret: string }> {
    // Body arrives as a raw Buffer because main.ts uses express.raw().
    let ownerId = '00000000-0000-0000-0000-000000000001';
    if (req.body && (req.body as Buffer).length > 0) {
      const parsed = JSON.parse((req.body as Buffer).toString('utf-8')) as {
        ownerId?: string;
      };
      if (parsed.ownerId) ownerId = parsed.ownerId;
    }
    return this.authSvc.createAccessKey(ownerId);
  }

  /**
   * GET /presign?bucket=&key=&method=GET&expires=<unix-ts>&accessKeyId=&secret=
   *
   * `expires` is an absolute Unix timestamp (seconds).  The resulting URL is valid
   * until that point in time.  If you prefer relative duration, pass the desired
   * expiry = Date.now()/1000 + <seconds> before calling this endpoint.
   */
  @Get('presign')
  async generatePresignedUrl(
    @Query('bucket') bucket: string,
    @Query('key') key: string,
    @Query('method') method: string,
    @Query('expires') expires: string,
    @Query('expiresIn') expiresIn: string,
    @Query('accessKeyId') accessKeyId: string,
    @Query('secret') secret: string,
    @Req() req: Request,
  ): Promise<{ url: string }> {
    if (!bucket || !key || !accessKeyId || !secret) {
      throw new UnauthorizedException('bucket, key, accessKeyId, and secret are required');
    }

    // Resolve absolute expiry: prefer `expires` (absolute unix ts), fall back to `expiresIn` (relative sec).
    let expiresAt: number;
    if (expires) {
      expiresAt = parseInt(expires, 10);
    } else {
      expiresAt = Math.floor(Date.now() / 1000) + parseInt(expiresIn ?? '3600', 10);
    }

    const baseUrl = `${req.protocol}://${req.headers['host'] ?? 'localhost:3000'}`;
    const url = await this.authSvc.generatePresignedUrl(
      {
        bucket,
        key,
        method: (method as 'GET' | 'PUT') ?? 'GET',
        expiresAt,
        accessKeyId,
      },
      secret,
      baseUrl,
    );
    return { url };
  }
}

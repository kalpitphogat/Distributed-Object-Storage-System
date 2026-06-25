import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { BucketsService } from './buckets.service';
import { Bucket } from '@mini-s3/shared-types';

@Controller('buckets')
export class BucketsController {
  constructor(private readonly bucketsService: BucketsService) {}

  @Put(':name')
  @HttpCode(200)
  create(@Param('name') name: string): Promise<Bucket> {
    return this.bucketsService.create(name);
  }

  @Get()
  findAll(): Promise<Bucket[]> {
    return this.bucketsService.findAll();
  }

  @Get(':name')
  findOne(@Param('name') name: string): Promise<Bucket> {
    return this.bucketsService.findOne(name);
  }

  @Delete(':name')
  @HttpCode(204)
  delete(@Param('name') name: string): Promise<void> {
    return this.bucketsService.delete(name);
  }

  // PUT /buckets/:name/versioning — enable or disable versioning
  @Put(':name/versioning')
  @HttpCode(200)
  setVersioning(@Param('name') name: string, @Req() req: Request): Promise<Bucket> {
    // Body arrives as a raw Buffer because main.ts uses express.raw({ type: '*/*' }).
    const body = parseJsonBody<{ enabled?: boolean }>(req);
    return this.bucketsService.setVersioning(name, body.enabled ?? true);
  }

  // PUT /buckets/:name/lifecycle — set lifecycle policy for this bucket
  @Put(':name/lifecycle')
  @HttpCode(200)
  setLifecycle(@Param('name') name: string, @Req() req: Request): Promise<void> {
    const body = parseJsonBody<{
      prefix?: string;
      expireAfterDays?: number;
      transitionToColdAfterDays?: number;
    }>(req);
    return this.bucketsService.setLifecyclePolicy(name, body);
  }
}

function parseJsonBody<T>(req: Request): T {
  const raw = req.body as Buffer | undefined;
  if (!raw || raw.length === 0) return {} as T;
  return JSON.parse(raw.toString('utf-8')) as T;
}

import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false, // disable NestJS's default body parsers so we control them
  });

  // Buffer the raw request body for all routes.
  // Object uploads are binary; bucket/health routes have empty bodies — safe either way.
  // Phase 2 will switch to a streaming pipeline for large objects.
  app.use(express.raw({ type: '*/*', limit: '1gb' }));

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);
  console.log(`Mini-S3 API running on port ${port}`);
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

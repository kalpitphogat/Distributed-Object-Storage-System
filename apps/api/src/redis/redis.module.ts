import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

// Global so any module can inject the Redis client without re-importing RedisModule.
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () =>
        new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
          // Prevents BullMQ's BLPOP from interfering with other commands.
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}

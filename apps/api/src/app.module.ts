import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { BucketsModule } from './buckets/buckets.module';
import { ObjectsModule } from './objects/objects.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    RedisModule,
    StorageModule,
    HealthModule,
    BucketsModule,
    ObjectsModule,
    AdminModule,
    AuthModule,
  ],
})
export class AppModule {}

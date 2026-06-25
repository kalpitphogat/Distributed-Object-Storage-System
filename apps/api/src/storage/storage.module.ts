import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { ChunkService } from './chunk.service';
import { RingService } from './ring.service';

@Module({
  providers: [StorageService, ChunkService, RingService],
  exports: [StorageService, ChunkService, RingService],
})
export class StorageModule {}

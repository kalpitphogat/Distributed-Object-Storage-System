import { Module } from '@nestjs/common';
import { ObjectsController } from './objects.controller';
import { ObjectsService } from './objects.service';
import { MultipartService } from '../multipart/multipart.service';
import { StorageModule } from '../storage/storage.module';
import { AuthModule } from '../auth/auth.module';

// MultipartService lives in this module (not a separate MultipartModule) because
// MultipartController is the same ObjectsController (query-param dispatching) and
// MultipartService calls ObjectsService.writeObjectMetadata — keeping them in one
// module avoids a circular-module dependency.
@Module({
  imports: [StorageModule, AuthModule],
  controllers: [ObjectsController],
  providers: [ObjectsService, MultipartService],
  exports: [ObjectsService],
})
export class ObjectsModule {}

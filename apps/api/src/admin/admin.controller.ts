import { Controller, Get, Param } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminSvc: AdminService) {}

  /** GET /admin/buckets — stats for all buckets */
  @Get('buckets')
  getAllBucketStats() {
    return this.adminSvc.getBucketStats();
  }

  /** GET /admin/buckets/:bucket/stats — stats for one bucket */
  @Get('buckets/:bucket/stats')
  getBucketStats(@Param('bucket') bucket: string) {
    return this.adminSvc.getBucketStats(bucket);
  }

  /** GET /admin/nodes — storage node health + replica load */
  @Get('nodes')
  getNodeHealth() {
    return this.adminSvc.getNodeHealth();
  }

  /** GET /admin/gc/stats — orphaned chunk count (for observability) */
  @Get('gc/stats')
  getGcStats() {
    return this.adminSvc.getGcStats();
  }
}

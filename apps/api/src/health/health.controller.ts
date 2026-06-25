import { Controller, Get, HttpCode } from '@nestjs/common';
import { HealthService, HealthStatus } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @HttpCode(200)
  async check(): Promise<HealthStatus> {
    return this.healthService.check();
  }
}

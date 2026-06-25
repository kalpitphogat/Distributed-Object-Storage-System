import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

export interface ComponentStatus {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  components: {
    postgres: ComponentStatus;
  };
  timestamp: string;
}

@Injectable()
export class HealthService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async check(): Promise<HealthStatus> {
    const postgres = await this.checkPostgres();
    const allOk = postgres.status === 'ok';

    return {
      status: allOk ? 'ok' : 'degraded',
      components: { postgres },
      timestamp: new Date().toISOString(),
    };
  }

  private async checkPostgres(): Promise<ComponentStatus> {
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      return {
        status: 'error',
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

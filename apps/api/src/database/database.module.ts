import { Module, Global } from '@nestjs/common';
import { Pool } from 'pg';

// The Pool token is used throughout the app via @Inject(PG_POOL).
// A single Pool is shared — pg maintains its own internal connection pool.
export const PG_POOL = 'PG_POOL';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new Pool({
          connectionString:
            process.env['DATABASE_URL'] ??
            'postgresql://miniadmin:minipassword@localhost:5432/minis3',
        }),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}

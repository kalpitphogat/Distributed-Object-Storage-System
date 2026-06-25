import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('HealthController', () => {
  let controller: HealthController;
  let service: HealthService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            check: jest.fn().mockResolvedValue({
              status: 'ok',
              components: {
                postgres: { status: 'ok', latencyMs: 1 },
              },
              timestamp: new Date().toISOString(),
            }),
          },
        },
      ],
    }).compile();

    controller = module.get(HealthController);
    service = module.get(HealthService);
  });

  it('returns ok status from health service', async () => {
    const result = await controller.check();
    expect(result.status).toBe('ok');
    expect(result.components.postgres.status).toBe('ok');
    expect(service.check).toHaveBeenCalledTimes(1);
  });
});

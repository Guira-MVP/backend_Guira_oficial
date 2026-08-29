import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { SUPABASE_CLIENT } from './core/supabase/supabase.module';

describe('AppController', () => {
  let appController: AppController;

  const mockSupabase = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({ data: [{ id: '1' }], error: null }),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key) => {
      if (key === 'app.bridgeApiKey') return 'sk_test_123';
      if (key === 'app.appEnv') return 'staging';
      return null;
    }),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: SUPABASE_CLIENT, useValue: mockSupabase },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('health', () => {
    it('reutiliza el sondeo a la base entre llamadas seguidas', async () => {
      // Render sondea cada ~4 s; sin caché eran 14 consultas/min a profiles.
      for (let i = 0; i < 5; i++) {
        await appController.getHealth();
      }

      expect(mockSupabase.limit).toHaveBeenCalledTimes(1);
    });

    it('vuelve a consultar pasados los 30 s de TTL', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-08-29T10:00:00Z'));

      await appController.getHealth();
      jest.setSystemTime(new Date('2026-08-29T10:00:31Z'));
      await appController.getHealth();

      expect(mockSupabase.limit).toHaveBeenCalledTimes(2);
    });

    it('varios sondeos simultáneos comparten una única consulta', async () => {
      await Promise.all([
        appController.getHealth(),
        appController.getHealth(),
        appController.getHealth(),
      ]);

      expect(mockSupabase.limit).toHaveBeenCalledTimes(1);
    });

    it('reporta degraded cuando la base devuelve error', async () => {
      mockSupabase.limit.mockResolvedValueOnce({
        data: null,
        error: { message: 'connection refused' },
      });

      const result = await appController.getHealth();

      expect(result.status).toBe('degraded');
      expect(result.services.database).toBe('unreachable');
    });

    it('no propaga la excepción si la consulta revienta', async () => {
      // Un healthcheck que responde 500 no le dice a Render qué está roto.
      mockSupabase.limit.mockRejectedValueOnce(new Error('socket hang up'));

      const result = await appController.getHealth();

      expect(result.status).toBe('degraded');
      expect(result.services.database).toBe('unreachable');
    });
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('debug-sentry', () => {
    it('requires a token in staging', () => {
      expect(() => appController.getDebugSentry()).toThrow(NotFoundException);
    });

    it('requires a token in production', () => {
      mockConfigService.get.mockImplementationOnce((key: string) =>
        key === 'app.appEnv' ? 'production' : null,
      );

      expect(() => appController.getDebugSentry()).toThrow(NotFoundException);
    });
  });
});

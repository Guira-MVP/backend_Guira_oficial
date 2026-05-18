import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

import { ConfigService } from '@nestjs/config';
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

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { FeesService } from './fees.service';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { Logger } from '@nestjs/common';

const mockSupabase = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  lte: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  maybeSingle: jest.fn(),
};

describe('FeesService', () => {
  let service: FeesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeesService,
        { provide: SUPABASE_CLIENT, useValue: mockSupabase },
      ],
    }).compile();

    module.useLogger(new Logger());
    service = module.get<FeesService>(FeesService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('debe priorizar el override del cliente (fixed fee) sobre el fallback local', async () => {
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: {
        fee_type: 'fixed',
        fee_fixed: 2.5,
      },
      error: null,
    }); // cliente override

    const result = await service.calculateFee('user-id', 'payout', 'ach', 100);

    expect(result.fee_amount).toBe(2.5);
    expect(result.net_amount).toBe(97.5);
  });

  it('debe usar el global param si el cliente no tiene override (percent fee)', async () => {
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null }); // no override
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: {
        fee_type: 'percent',
        fee_percent: 1.5,
      },
      error: null,
    }); // global param

    const result = await service.calculateFee('user-id', 'payout', 'ach', 1000);

    expect(result.fee_amount).toBe(15.0); // 1.5% de 1000
    expect(result.net_amount).toBe(985.0);
  });

  it('debe respetar el min_fee y max_fee del global configs si aplica', async () => {
    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    // Config global: 1% min 10 max 50
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: {
        fee_type: 'percent',
        fee_percent: 1,
        min_fee: 10,
        max_fee: 50,
      },
      error: null,
    });

    // Envío muy poco: 100 * 1% = 1. Como min = 10 -> fee será 10.
    const resultMin = await service.calculateFee(
      'user-id',
      'payout',
      'ach',
      100,
    );
    expect(resultMin.fee_amount).toBe(10);
    expect(resultMin.net_amount).toBe(90);

    mockSupabase.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockSupabase.maybeSingle.mockResolvedValueOnce({
      data: { fee_type: 'percent', fee_percent: 1, min_fee: 10, max_fee: 50 },
      error: null,
    });

    // Envío mucho: 100,000 * 1% = 1,000. Como max = 50 -> fee será 50.
    const resultMax = await service.calculateFee(
      'user-id',
      'payout',
      'ach',
      100000,
    );
    expect(resultMax.fee_amount).toBe(50);
    expect(resultMax.net_amount).toBe(99950);
  });
});

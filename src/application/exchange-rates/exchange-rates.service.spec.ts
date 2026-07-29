import { Test, TestingModule } from '@nestjs/testing';
import { Logger, BadRequestException } from '@nestjs/common';
import { ExchangeRatesService } from './exchange-rates.service';
import { ExchangeRatesGateway } from './exchange-rates.gateway';
import { BridgeApiClient } from '../bridge/bridge-api.client';
import { BinanceP2pClient } from './binance-p2p.client';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';

jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn() }));

const mockSupabase = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  single: jest.fn(),
};

const mockGateway = { emitRateUpdated: jest.fn() };
const mockBridgeApi = { get: jest.fn() };
const mockBinanceP2p = { getAveragePrice: jest.fn() };

describe('ExchangeRatesService.syncExternalRates', () => {
  let service: ExchangeRatesService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExchangeRatesService,
        { provide: SUPABASE_CLIENT, useValue: mockSupabase },
        { provide: ExchangeRatesGateway, useValue: mockGateway },
        { provide: BridgeApiClient, useValue: mockBridgeApi },
        { provide: BinanceP2pClient, useValue: mockBinanceP2p },
      ],
    }).compile();

    module.useLogger(new Logger());
    service = module.get<ExchangeRatesService>(ExchangeRatesService);

    // getRate() interno de updateRateInternal: par ya existente con spread 0
    mockSupabase.single.mockResolvedValue({
      data: { pair: 'BOB_USD', rate: '11.9', spread_percent: '0' },
      error: null,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('escribe BOB_USD con el promedio "BUY" y USD_BOB con el promedio "SELL" de Binance', async () => {
    mockBinanceP2p.getAveragePrice
      .mockResolvedValueOnce(11.92) // BUY -> BOB_USD
      .mockResolvedValueOnce(11.89); // SELL -> USD_BOB

    // syncBridgeCrossRates hace más llamadas a getRate/bridgeApi; que fallen
    // silenciosamente no debe afectar el resultado de los pares ancla.
    mockBridgeApi.get.mockRejectedValue(new Error('bridge down'));

    const result = await service.syncExternalRates('system_cron');

    expect(mockBinanceP2p.getAveragePrice).toHaveBeenNthCalledWith(
      1,
      'BUY',
      10,
    );
    expect(mockBinanceP2p.getAveragePrice).toHaveBeenNthCalledWith(
      2,
      'SELL',
      10,
    );
    expect(result.buy_rate_bob_usd).toBe(11.92);
    expect(result.sell_rate_usd_bob).toBe(11.89);

    const updateCalls = mockSupabase.update.mock.calls.map((c) => c[0]);
    expect(updateCalls.some((c) => c.rate === 11.92)).toBe(true);
    expect(updateCalls.some((c) => c.rate === 11.89)).toBe(true);
  });

  it('propaga BadRequestException si Binance falla, sin tocar syncBridgeCrossRates', async () => {
    mockBinanceP2p.getAveragePrice.mockRejectedValueOnce(
      new Error('Binance no disponible'),
    );

    await expect(service.syncExternalRates('system_cron')).rejects.toThrow(
      BadRequestException,
    );

    // Solo se llamó una vez (BUY), nunca se llegó a pedir SELL ni a Bridge
    expect(mockBinanceP2p.getAveragePrice).toHaveBeenCalledTimes(1);
    expect(mockBridgeApi.get).not.toHaveBeenCalled();
  });
});

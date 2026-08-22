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
  order: jest.fn(),
  single: jest.fn(),
  // Resultado del UPDATE: la cadena from().update().eq() termina aquí, y
  // updateRateInternal comprueba este campo. Los tests que simulan un fallo
  // de escritura lo sobrescriben.
  error: null as { message: string } | null,
};

/** Filas tal como las devuelve exchange_rates_config (valores en string). */
const buildRows = () => [
  { pair: 'BOB_USD', rate: '11.9', spread_percent: '0', bridge_buy_rate: null, bridge_sell_rate: null },
  { pair: 'USD_BOB', rate: '11.8', spread_percent: '0', bridge_buy_rate: null, bridge_sell_rate: null },
  ...['EUR', 'MXN', 'BRL', 'COP', 'GBP'].flatMap((c) => [
    { pair: `BOB_${c}`, rate: '1', spread_percent: '0', bridge_buy_rate: '0.9', bridge_sell_rate: '0.85' },
    { pair: `${c}_BOB`, rate: '1', spread_percent: '0', bridge_buy_rate: '0.9', bridge_sell_rate: '0.85' },
    { pair: `USD_${c}`, rate: '1', spread_percent: '0', bridge_buy_rate: '0.9', bridge_sell_rate: '0.85' },
  ]),
];

const mockGateway = { emitRateUpdated: jest.fn(), emitRatesBatch: jest.fn() };
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

    mockSupabase.error = null;

    // getAllRates(): snapshot del ciclo, una sola lectura de la tabla
    mockSupabase.order.mockResolvedValue({ data: buildRows(), error: null });

    // getRate() individual: solo debería usarse como fallback fuera del cron
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

  it('lee la tabla una sola vez por ciclo, sin consultas por par', async () => {
    mockBinanceP2p.getAveragePrice
      .mockResolvedValueOnce(11.92)
      .mockResolvedValueOnce(11.89);
    mockBridgeApi.get.mockResolvedValue({
      midmarket_rate: '0.87',
      buy_rate: '0.9',
      sell_rate: '0.85',
    });

    await service.syncExternalRates('system_cron');

    // Un único getAllRates() cubre los 17 pares
    expect(mockSupabase.order).toHaveBeenCalledTimes(1);
    // Ningún getRate() individual: antes eran 19 por ciclo
    expect(mockSupabase.single).not.toHaveBeenCalled();
  });

  it('calcula los cruzados con el BOB_USD del ciclo actual, no el anterior', async () => {
    // El snapshot arranca con BOB_USD=11.9; Binance devuelve 11.92 y ese es
    // el valor que deben usar los cruzados. Con sell_rate=0.85:
    //   correcto  -> 11.92 / 0.85 = 14.023529
    //   incorrecto -> 11.9  / 0.85 = 14.0
    mockBinanceP2p.getAveragePrice
      .mockResolvedValueOnce(11.92)
      .mockResolvedValueOnce(11.89);
    mockBridgeApi.get.mockResolvedValue({
      midmarket_rate: '0.87',
      buy_rate: '0.9',
      sell_rate: '0.85',
    });

    await service.syncExternalRates('system_cron');

    const bobEur = mockGateway.emitRatesBatch.mock.calls[0][0].find(
      (p: { pair: string }) => p.pair === 'BOB_EUR',
    );
    expect(bobEur.base_rate).toBeCloseTo(14.023529, 6);
    expect(bobEur.base_rate).not.toBeCloseTo(14.0, 6);
  });

  it('emite un único lote por ciclo con los 17 pares', async () => {
    mockBinanceP2p.getAveragePrice
      .mockResolvedValueOnce(11.92)
      .mockResolvedValueOnce(11.89);
    mockBridgeApi.get.mockResolvedValue({
      midmarket_rate: '0.87',
      buy_rate: '0.9',
      sell_rate: '0.85',
    });

    await service.syncExternalRates('system_cron');

    expect(mockGateway.emitRatesBatch).toHaveBeenCalledTimes(1);
    expect(mockGateway.emitRatesBatch.mock.calls[0][0]).toHaveLength(17);
    // En el ciclo del cron no se emiten eventos sueltos
    expect(mockGateway.emitRateUpdated).not.toHaveBeenCalled();
  });

  it('no emite ni propaga al snapshot un par cuyo UPDATE falla', async () => {
    mockBinanceP2p.getAveragePrice
      .mockResolvedValueOnce(11.92)
      .mockResolvedValueOnce(11.89);
    mockBridgeApi.get.mockRejectedValue(new Error('bridge down'));
    mockSupabase.error = { message: 'permission denied' };

    await service.syncExternalRates('system_cron');

    // Ningún par llegó a guardarse, así que el lote va vacío. El gateway
    // descarta los lotes vacíos, de modo que no sale ningún frame.
    expect(mockGateway.emitRatesBatch.mock.calls[0][0]).toEqual([]);
    expect(mockGateway.emitRateUpdated).not.toHaveBeenCalled();
  });
});

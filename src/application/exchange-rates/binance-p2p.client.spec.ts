import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadGatewayException, Logger } from '@nestjs/common';
import { BinanceP2pClient } from './binance-p2p.client';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as Response;
}

describe('BinanceP2pClient', () => {
  let client: BinanceP2pClient;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BinanceP2pClient,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    module.useLogger(new Logger());
    client = module.get<BinanceP2pClient>(BinanceP2pClient);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('calcula el promedio de los precios devueltos por Binance', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { adv: { price: '11.90' } },
          { adv: { price: '11.92' } },
          { adv: { price: '11.94' } },
        ],
      }),
    );

    const avg = await client.getAveragePrice('BUY', 3);

    expect(avg).toBeCloseTo(11.92, 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      asset: 'USDT',
      fiat: 'BOB',
      tradeType: 'BUY',
      page: 1,
      rows: 3,
      payTypes: [],
      publisherType: null,
    });
  });

  it('lanza error si Binance devuelve data vacío (aunque el HTTP sea 200)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    await expect(client.getAveragePrice('SELL', 10)).rejects.toThrow(
      BadGatewayException,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 intento + 1 reintento
  });

  it('reintenta una vez y falla con BadGatewayException si la respuesta no es 2xx', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, false, 500))
      .mockResolvedValueOnce(jsonResponse({}, false, 500));

    await expect(client.getAveragePrice('BUY', 10)).rejects.toThrow(
      BadGatewayException,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('se recupera si el primer intento falla y el reintento sí funciona', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ adv: { price: '11.90' } }] }),
      );

    const avg = await client.getAveragePrice('BUY', 10);

    expect(avg).toBe(11.9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignora precios inválidos (NaN o <= 0) y promedia solo los válidos', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          { adv: { price: '11.90' } },
          { adv: { price: 'no-es-numero' } },
          { adv: { price: '0' } },
          { adv: { price: '12.10' } },
        ],
      }),
    );

    const avg = await client.getAveragePrice('BUY', 4);

    expect(avg).toBe(12.0); // promedio de 11.90 y 12.10
  });
});

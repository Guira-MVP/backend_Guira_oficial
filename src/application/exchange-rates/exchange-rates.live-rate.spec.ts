import { BadRequestException } from '@nestjs/common';
import { ExchangeRatesService } from './exchange-rates.service';

/**
 * getLiveUsdRate: tasa USD→X pedida a Bridge en el momento, con el spread de
 * USD_X. Es la que usa Fixed Outputs al cotizar y al aprobar, porque
 * exchange_rates_config.updated_at no indica si la tasa guardada está vigente.
 */
describe('ExchangeRatesService.getLiveUsdRate', () => {
  function makeService(
    opts: { sellRate?: string; bridgeFails?: boolean; spread?: string } = {},
  ) {
    const single = jest.fn().mockResolvedValue({
      data: {
        pair: 'USD_EUR',
        rate: '0.8700',
        spread_percent: opts.spread ?? '1',
        bridge_sell_rate: '0.8700',
        bridge_buy_rate: '0.8800',
        updated_at: '2026-09-01T00:00:00Z',
      },
      error: null,
    });
    const query: any = { select: () => query, eq: () => query, single };
    const supabase = { from: jest.fn(() => query) };
    const bridgeGet = opts.bridgeFails
      ? jest.fn().mockRejectedValue(new Error('timeout'))
      : jest.fn().mockResolvedValue({
          midmarket_rate: '0.8760',
          sell_rate: opts.sellRate ?? '0.8727',
          buy_rate: '0.8813',
        });
    const service = new ExchangeRatesService(
      supabase as any,
      {} as any,
      { get: bridgeGet } as any,
      {} as any,
    );
    return { service, bridgeGet };
  }

  it('usa la tasa de Bridge de ahora (no la guardada) y le aplica el spread', async () => {
    const { service, bridgeGet } = makeService();

    const r = await service.getLiveUsdRate('eur');

    expect(bridgeGet).toHaveBeenCalledWith(
      '/v0/exchange_rates?from=usd&to=eur',
    );
    expect(r.pair).toBe('USD_EUR');
    expect(r.bridge_sell_rate).toBe(0.8727);
    expect(r.spread_percent).toBe(1);
    // 0.8727 × 0.99 = 0.863973 (6 decimales truncados, como getRate)
    expect(r.effective_rate).toBe(0.863973);
  });

  it('si Bridge no responde, no cotiza', async () => {
    const { service } = makeService({ bridgeFails: true });
    await expect(service.getLiveUsdRate('EUR')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('si Bridge devuelve una tasa inválida, no cotiza', async () => {
    const { service } = makeService({ sellRate: '0' });
    await expect(service.getLiveUsdRate('EUR')).rejects.toThrow(
      /tipo de cambio actual para EUR/,
    );
  });
});

/**
 * getBridgeUsdRateForEstimate: la tasa que usa la calculadora de importe
 * flexible. Sin spread (Guira solo cobra el developer fee) y, a diferencia de
 * getLiveUsdRate, con respaldo en la última tasa sincronizada: es una
 * estimación, no un cobro.
 */
describe('ExchangeRatesService.getBridgeUsdRateForEstimate', () => {
  function makeService(opts: { bridgeFails?: boolean } = {}) {
    const single = jest.fn().mockResolvedValue({
      data: {
        pair: 'USD_EUR',
        rate: '0.8700',
        spread_percent: '1',
        bridge_sell_rate: '0.8700',
        bridge_buy_rate: '0.8800',
        updated_at: '2026-09-01T00:00:00Z',
      },
      error: null,
    });
    const query: any = { select: () => query, eq: () => query, single };
    const supabase = { from: jest.fn(() => query) };
    const bridgeGet = opts.bridgeFails
      ? jest.fn().mockRejectedValue(new Error('timeout'))
      : jest.fn().mockResolvedValue({ sell_rate: '0.8727' });
    return new ExchangeRatesService(
      supabase as any,
      {} as any,
      { get: bridgeGet } as any,
      {} as any,
    );
  }

  it('devuelve la sell_rate de Bridge sin spread', async () => {
    const r = await makeService().getBridgeUsdRateForEstimate('eur');
    expect(r).toMatchObject({ pair: 'USD_EUR', rate: 0.8727, source: 'live' });
  });

  it('si Bridge no responde, usa la última tasa sincronizada y lo indica', async () => {
    const r = await makeService({ bridgeFails: true }).getBridgeUsdRateForEstimate('EUR');
    expect(r).toMatchObject({
      rate: 0.87,
      source: 'cached',
      fetched_at: '2026-09-01T00:00:00Z',
    });
  });
});

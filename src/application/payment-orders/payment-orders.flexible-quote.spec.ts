import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentOrdersService } from './payment-orders.service';

/**
 * Calculadora de expedientes de importe flexible.
 *
 * Lo que se protege aquí:
 *   1. La comisión es la congelada en el expediente (transfer → contexto de
 *      revisión), no la configuración vigente del cliente.
 *   2. La configuración vigente se resuelve contra el titular de la orden.
 *   3. wallet_to_wallet y los destinos USD no convierten divisa.
 *   4. Otros flujos y expedientes cerrados se rechazan.
 */
describe('PaymentOrdersService — getFlexibleQuoteContext', () => {
  const ORDER_ID = 'a1b2c3d4-0000-4000-8000-000000000042';

  function worldOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: ORDER_ID,
      user_id: 'owner-1',
      flow_type: 'wallet_to_world',
      status: 'waiting_deposit',
      supplier_id: 'sup-1',
      source_network: 'solana',
      source_currency: 'USDC',
      currency: 'USDC',
      destination_network: null,
      destination_currency: 'EUR',
      bridge_transfer_id: 'tr_1',
      bridge_execution_context: null,
      ...overrides,
    };
  }

  function makeSupabase(
    order: any,
    tables: Record<string, any> = {},
  ) {
    const from = jest.fn((table: string) => {
      const query: any = {
        select: jest.fn(() => query),
        eq: jest.fn(() => query),
        single: jest.fn(async () => ({
          data: table === 'payment_orders' ? order : null,
          error: order ? null : { message: 'not found' },
        })),
        maybeSingle: jest.fn(async () => ({ data: tables[table] ?? null, error: null })),
      };
      return query;
    });
    return { from };
  }

  function makeService(
    supabase: any,
    opts: {
      preview?: { fee_percent: number; is_override: boolean };
      rate?: { rate: number; source: 'live' | 'cached'; fetched_at: string };
    } = {},
  ) {
    const previewFee = jest
      .fn()
      .mockResolvedValue(opts.preview ?? { fee_percent: 1, is_override: false });
    const getBridgeUsdRateForEstimate = jest.fn().mockResolvedValue(
      opts.rate ?? { pair: 'USD_EUR', rate: 0.92, source: 'live', fetched_at: '2026-09-25T00:00:00Z' },
    );
    const service = new PaymentOrdersService(
      supabase,
      { previewFee } as any,
      {} as any,
      { getBridgeUsdRateForEstimate } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    ) as any;
    return { service, previewFee, getBridgeUsdRateForEstimate };
  }

  it('usa el % congelado en el transfer aunque la configuración actual sea otra', async () => {
    const supabase = makeSupabase(worldOrder(), {
      suppliers: { payment_rail: 'sepa' },
      bridge_transfers: { developer_fee_percent: '1.5' },
    });
    const { service, previewFee } = makeService(supabase, {
      preview: { fee_percent: 3, is_override: false },
    });

    const quote = await service.getFlexibleQuoteContext('owner-1', ORDER_ID);

    expect(quote.fee_percent).toBe(1.5);
    expect(quote.fee_source).toBe('transfer');
    expect(quote.is_override).toBe(false);
    expect(previewFee).toHaveBeenCalledWith('owner-1', 'ramp_off_wallet_world', 'sepa', 'eur', 0);
  });

  it('marca tarifa preferencial cuando el % congelado es el override vigente', async () => {
    const supabase = makeSupabase(worldOrder(), {
      suppliers: { payment_rail: 'sepa' },
      bridge_transfers: { developer_fee_percent: '1.2' },
    });
    const { service } = makeService(supabase, {
      preview: { fee_percent: 1.2, is_override: true },
    });

    const quote = await service.getFlexibleQuoteContext('owner-1', ORDER_ID);

    expect(quote.is_override).toBe(true);
  });

  it('en revisión (sin transfer) toma el % del contexto congelado', async () => {
    const supabase = makeSupabase(
      worldOrder({
        status: 'pending_review',
        bridge_transfer_id: null,
        bridge_execution_context: { kind: 'wallet_to_world', fee_percent: '2' },
      }),
      { suppliers: { payment_rail: 'sepa' } },
    );
    const { service } = makeService(supabase);

    const quote = await service.getFlexibleQuoteContext('owner-1', ORDER_ID);

    expect(quote.fee_percent).toBe(2);
    expect(quote.fee_source).toBe('review_context');
  });

  it('sin nada congelado recurre a la configuración vigente del titular', async () => {
    const supabase = makeSupabase(
      worldOrder({ bridge_transfer_id: null }),
      { suppliers: { payment_rail: 'sepa' } },
    );
    const { service } = makeService(supabase, {
      preview: { fee_percent: 1.8, is_override: true },
    });

    const quote = await service.getFlexibleQuoteContext('owner-1', ORDER_ID);

    expect(quote.fee_percent).toBe(1.8);
    expect(quote.fee_source).toBe('current_config');
    expect(quote.is_override).toBe(true);
  });

  it('aplica la tasa de Bridge y el mínimo de la red de origen', async () => {
    const supabase = makeSupabase(worldOrder(), {
      suppliers: { payment_rail: 'sepa' },
      bridge_transfers: { developer_fee_percent: '1' },
    });
    const { service, getBridgeUsdRateForEstimate } = makeService(supabase);

    const quote = await service.getFlexibleQuoteContext('owner-1', ORDER_ID);

    expect(getBridgeUsdRateForEstimate).toHaveBeenCalledWith('eur');
    expect(quote.rate_applies).toBe(true);
    expect(quote.exchange_rate).toBe(0.92);
    expect(quote.rate_source).toBe('live');
    expect(quote.min_amount).toBe(1);
  });

  it('destino USD: sin conversión ni llamada a Bridge', async () => {
    const supabase = makeSupabase(worldOrder({ destination_currency: 'USD' }), {
      suppliers: { payment_rail: 'ach' },
      bridge_transfers: { developer_fee_percent: '1' },
    });
    const { service, getBridgeUsdRateForEstimate } = makeService(supabase);

    const quote = await service.getFlexibleQuoteContext('owner-1', ORDER_ID);

    expect(quote.rate_applies).toBe(false);
    expect(quote.exchange_rate).toBe(1);
    expect(getBridgeUsdRateForEstimate).not.toHaveBeenCalled();
  });

  it('wallet_to_wallet usa la clave interbank_w2w y tasa 1', async () => {
    const supabase = makeSupabase(
      worldOrder({
        flow_type: 'wallet_to_wallet',
        supplier_id: 'sup-2',
        destination_network: 'solana',
        destination_currency: 'USDC',
      }),
      { bridge_transfers: { developer_fee_percent: '0.5' } },
    );
    const { service, previewFee, getBridgeUsdRateForEstimate } = makeService(supabase);

    const quote = await service.getFlexibleQuoteContext('owner-1', ORDER_ID);

    expect(previewFee).toHaveBeenCalledWith('owner-1', 'interbank_w2w', 'bridge', 'usdc', 0);
    expect(quote.fee_percent).toBe(0.5);
    expect(quote.rate_applies).toBe(false);
    expect(getBridgeUsdRateForEstimate).not.toHaveBeenCalled();
  });

  it('rechaza flujos que no son de importe flexible', async () => {
    const supabase = makeSupabase(worldOrder({ flow_type: 'bolivia_to_world' }));
    const { service } = makeService(supabase);

    await expect(
      service.getFlexibleQuoteContext('owner-1', ORDER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza expedientes que ya no esperan depósito', async () => {
    const supabase = makeSupabase(worldOrder({ status: 'processing' }));
    const { service } = makeService(supabase);

    await expect(
      service.getFlexibleQuoteContext('owner-1', ORDER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una orden de otra cuenta responde 404', async () => {
    const supabase = makeSupabase(null);
    const { service } = makeService(supabase);

    await expect(
      service.getFlexibleQuoteContext('otro-usuario', ORDER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

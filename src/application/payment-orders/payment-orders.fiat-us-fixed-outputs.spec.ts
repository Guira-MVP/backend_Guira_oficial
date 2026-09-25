import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { PaymentOrdersService } from './payment-orders.service';
import { BridgeSourceAmountTooLowError } from '../bridge/bridge-api.client';
import { calculateFixedOutputAmounts } from './fiat-us-fixed-output';

/**
 * bridge_wallet_to_fiat_us con destino no-USD usa Fixed Outputs: el proveedor
 * recibe exactamente el monto cotizado y el colchón es el spread de USD_X.
 *
 * Lo que se protege aquí:
 *   1. El servidor recalcula los USDC a debitar; no confía en la tasa del cliente.
 *   2. Solo USDC como origen para destinos no-USD.
 *   3. Al aprobar, el Transfer lleva source.amount + destination.amount y no `amount`.
 *   4. Si la tasa se comió el colchón, NO se llama a Bridge y el expediente
 *      vuelve a revisión para que el staff lo rechace.
 *   5. USD y los expedientes previos al cambio siguen con el formato anterior.
 */
describe('PaymentOrdersService — bridge_wallet_to_fiat_us con Fixed Outputs', () => {
  const ORDER_ID = 'f1f2f3f4-0000-4000-8000-000000000001';
  const SELL = 0.8955;
  const SPREAD = 0.01;
  const CLIENT_RATE = Math.trunc(SELL * (1 - SPREAD) * 1e6) / 1e6;
  const RULE = {
    fee_type: 'percent' as const,
    fee_percent: 3,
    fee_fixed: 0,
    min_fee: 0,
    max_fee: 500,
  };
  const QUOTE = calculateFixedOutputAmounts({
    destinationAmount: 1000,
    clientRate: CLIENT_RATE,
    bridgeSellRate: SELL,
    rule: RULE,
  });

  function makeSupabase(
    opts: {
      extCurrency?: string;
      order?: any;
      balance?: number;
    } = {},
  ) {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
    const updates: Record<string, any[]> = {};
    const inserts: Record<string, any[]> = {};
    const extCurrency = opts.extCurrency ?? 'eur';

    const tableData: Record<string, any> = {
      suppliers: {
        id: 'sup-1',
        name: 'Proveedor SL',
        bridge_external_account_id: 'ext-local-1',
        bank_details: {
          bank_name: 'ABN',
          account_number: 'NL91ABNA0417164300',
        },
        payment_rail: extCurrency === 'usd' ? 'ach' : 'sepa',
        compliance_status: 'clear',
      },
      bridge_external_accounts: {
        id: 'ext-local-1',
        account_type: 'iban',
        currency: extCurrency,
        bridge_external_account_id: 'ea_bridge_1',
        is_active: true,
      },
      profiles: { bridge_customer_id: 'cus_123', role: 'staff' },
      balances: { available_amount: String(opts.balance ?? 5000) },
      wallets: { id: 'wallet-1', provider_wallet_id: 'bw_1', is_active: true },
      bridge_transfers: { id: 'bt-local-1' },
    };

    const from = jest.fn((table: string) => {
      const query: any = {
        __isUpdate: false,
        __isInsert: false,
        select: jest.fn(() => query),
        insert: jest.fn((payload: any) => {
          query.__isInsert = true;
          (inserts[table] ??= []).push(payload);
          query.__inserted = payload;
          return query;
        }),
        update: jest.fn((payload: unknown) => {
          query.__isUpdate = true;
          (updates[table] ??= []).push(payload);
          return query;
        }),
        eq: jest.fn(() => query),
        in: jest.fn(() => query),
        or: jest.fn(() => query),
        limit: jest.fn(() => query),
        then: (resolve: any) => resolve({ data: null, error: null }),
        single: jest.fn().mockImplementation(async () => {
          if (table === 'payment_orders') {
            if (query.__isInsert)
              return {
                data: { id: ORDER_ID, ...query.__inserted },
                error: null,
              };
            return { data: opts.order, error: null };
          }
          if (table === 'bridge_transfers' && query.__isInsert) {
            return { data: { id: 'bt-local-1' }, error: null };
          }
          return { data: tableData[table], error: null };
        }),
        maybeSingle: jest.fn().mockImplementation(async () => {
          if (table === 'payment_orders') {
            // CAS de la aprobación → fila reclamada. Lectura de conflictos → ninguno.
            return {
              data: query.__isUpdate
                ? { ...opts.order, status: 'processing' }
                : null,
              error: null,
            };
          }
          if (table === 'bridge_transfers') return { data: null, error: null };
          return { data: tableData[table], error: null };
        }),
      };
      return query;
    });

    return { from, rpc, __updates: updates, __inserts: inserts };
  }

  function makeService(
    supabase: any,
    opts: {
      bridgePost?: jest.Mock;
      liveSell?: number;
      liveRateFails?: boolean;
    } = {},
  ) {
    const bridgePost =
      opts.bridgePost ??
      jest.fn().mockResolvedValue({
        id: 'bridge-transfer-uuid',
        state: 'awaiting_funds',
      });
    const liveSell = opts.liveSell ?? SELL;
    const getRate = jest.fn().mockImplementation(async () => ({
      effective_rate: Math.trunc(liveSell * (1 - SPREAD) * 1e6) / 1e6,
      base_rate: liveSell,
      bridge_sell_rate: liveSell,
      updated_at: new Date().toISOString(),
    }));
    // Fixed Outputs cotiza y comprueba el margen con la tasa en vivo de Bridge.
    const getLiveUsdRate = jest.fn().mockImplementation(async () => {
      if (opts.liveRateFails) {
        throw new BadRequestException('No pudimos obtener el tipo de cambio');
      }
      return {
        pair: 'USD_EUR',
        bridge_sell_rate: liveSell,
        spread_percent: SPREAD * 100,
        effective_rate: Math.trunc(liveSell * (1 - SPREAD) * 1e6) / 1e6,
        fetched_at: new Date().toISOString(),
      };
    });

    const service = new PaymentOrdersService(
      supabase,
      {
        calculateFee: jest
          .fn()
          .mockImplementation(async (_u, _o, _r, _c, amount: number) => ({
            fee_amount: Math.round(amount * 3) / 100,
            net_amount: amount - Math.round(amount * 3) / 100,
          })),
        getFeeConfigRow: jest.fn().mockResolvedValue(RULE),
      } as any,
      {} as any,
      { getRate, getLiveUsdRate } as any,
      { post: bridgePost } as any,
      {} as any,
      {} as any,
      { sendNotification: jest.fn().mockResolvedValue(undefined) } as any,
      { emitOrderCreated: jest.fn(), emitOrderUpdated: jest.fn() } as any,
      {
        sendPaymentOrderFailedEmail: jest.fn(),
        sendPaymentOrderCompletedEmail: jest.fn(),
      } as any,
      {} as any,
      { requiresReview: jest.fn().mockResolvedValue(true) } as any,
      { assertUsableForPayment: jest.fn() } as any,
    ) as any;

    return { service, bridgePost, getRate, getLiveUsdRate };
  }

  const baseDto = {
    flow_type: 'bridge_wallet_to_fiat_us',
    wallet_id: 'wallet-1',
    supplier_id: 'sup-1',
    source_currency: 'usdc',
    business_purpose: 'Pago de factura',
  };

  // ── Creación ──

  it('reserva los USDC que calcula el servidor y congela el destino garantizado', async () => {
    const supabase = makeSupabase();
    const { service, bridgePost } = makeService(supabase);

    await service.createBridgeWalletToFiatUs(
      'user-1',
      { ...baseDto, amount: QUOTE.source_amount, destination_amount: 1000 },
      { skipReviewGate: false },
    );

    expect(bridgePost).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith(
      'reserve_balance',
      expect.objectContaining({
        p_amount: QUOTE.source_amount,
      }),
    );
    const inserted = supabase.__inserts['payment_orders'][0];
    expect(inserted).toMatchObject({
      status: 'pending_review',
      amount: QUOTE.source_amount,
      amount_destination: 1000,
      exchange_rate_applied: CLIENT_RATE,
      fx_mode: 'fixed_output',
      fee_amount: QUOTE.fee_amount,
    });
    expect(inserted.fx_buffer_amount).toBeGreaterThan(0);
    expect(inserted.bridge_execution_context).toMatchObject({
      fx_mode: 'fixed_output',
      destination_amount: 1000,
      amount: QUOTE.source_amount,
      total_needed: QUOTE.source_amount,
    });
  });

  it('rechaza si el débito subió respecto de lo que el cliente aceptó', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);

    await expect(
      service.createBridgeWalletToFiatUs(
        'user-1',
        {
          ...baseDto,
          amount: QUOTE.source_amount * 0.98,
          destination_amount: 1000,
        },
        { skipReviewGate: false },
      ),
    ).rejects.toThrow(/vuelve a cotizar/i);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('sin destination_amount (frontend anterior) deriva el destino desde amount', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);

    await service.createBridgeWalletToFiatUs(
      'user-1',
      { ...baseDto, amount: 1000 },
      { skipReviewGate: false },
    );

    const inserted = supabase.__inserts['payment_orders'][0];
    expect(inserted.fx_mode).toBe('fixed_output');
    expect(inserted.amount).toBeLessThanOrEqual(1000);
    expect(inserted.amount_destination).toBeGreaterThan(0);
  });

  it('solo admite USDC como origen para destinos no-USD', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);

    await expect(
      service.createBridgeWalletToFiatUs(
        'user-1',
        {
          ...baseDto,
          source_currency: 'usdt',
          amount: 1200,
          destination_amount: 1000,
        },
        { skipReviewGate: false },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('destino USD no cambia: sin fx_mode y con el monto del cliente', async () => {
    const supabase = makeSupabase({ extCurrency: 'usd' });
    const { service } = makeService(supabase);

    await service.createBridgeWalletToFiatUs(
      'user-1',
      { ...baseDto, amount: 1000 },
      { skipReviewGate: false },
    );

    const inserted = supabase.__inserts['payment_orders'][0];
    expect(inserted).toMatchObject({
      amount: 1000,
      fee_amount: 30,
      exchange_rate_applied: 1,
      fx_mode: null,
    });
    expect(inserted.bridge_execution_context.fx_mode).toBeUndefined();
  });

  // ── Aprobación ──

  function pendingOrder(ctxOverrides: Record<string, unknown> = {}) {
    return {
      id: ORDER_ID,
      user_id: 'user-1',
      wallet_id: 'wallet-1',
      flow_type: 'bridge_wallet_to_fiat_us',
      status: 'pending_review',
      amount: QUOTE.source_amount,
      currency: 'USDC',
      notes: null,
      bridge_execution_context: {
        kind: 'bridge_wallet_to_fiat_us',
        source_currency: 'USDC',
        amount: QUOTE.source_amount,
        fee_amount: QUOTE.fee_amount,
        net_amount: QUOTE.net_amount,
        total_needed: QUOTE.source_amount,
        supplier_payment_rail: 'sepa',
        external_account_local_id: 'ext-local-1',
        destination_currency: 'eur',
        fx_mode: 'fixed_output',
        destination_amount: 1000,
        client_rate: CLIENT_RATE,
        ...ctxOverrides,
      },
    };
  }

  it('al aprobar crea el Transfer con source.amount + destination.amount y sin amount raíz', async () => {
    const supabase = makeSupabase({ order: pendingOrder() });
    const { service, bridgePost } = makeService(supabase);

    await service.approveOrderReviewStep(ORDER_ID, 'staff-1', {});

    expect(bridgePost).toHaveBeenCalledTimes(1);
    const [path, body, key] = bridgePost.mock.calls[0];
    expect(path).toBe('/v0/transfers');
    expect(key).toBe(`po_w2f_fo_${ORDER_ID}`);
    expect(body.amount).toBeUndefined();
    expect(body.source).toMatchObject({
      payment_rail: 'bridge_wallet',
      currency: 'usdc',
      amount: QUOTE.source_amount.toFixed(2),
    });
    expect(body.destination).toMatchObject({
      payment_rail: 'sepa',
      currency: 'eur',
      external_account_id: 'ea_bridge_1',
      amount: '1000.00',
    });
    expect(body.developer_fee).toBe(QUOTE.fee_amount.toFixed(2));
  });

  it('si la tasa se comió el colchón, no llama a Bridge y vuelve a revisión', async () => {
    const supabase = makeSupabase({ order: pendingOrder() });
    // La tasa cayó un 2% y el colchón (spread) era del 1%.
    const { service, bridgePost } = makeService(supabase, {
      liveSell: SELL * 0.98,
    });

    const approval = service.approveOrderReviewStep(ORDER_ID, 'staff-1', {});
    await expect(approval).rejects.toThrow(/vuelva a cotizar/i);
    // No se le pidió nada a Bridge: el mensaje no debe decir que Bridge falló.
    await expect(approval).rejects.toThrow(/^No se envió la transferencia/);
    expect(bridgePost).not.toHaveBeenCalled();
    const statuses = supabase.__updates['payment_orders'].map(
      (u: any) => u.status,
    );
    expect(statuses).toContain('pending_review');
    // La reserva NO se libera: el expediente sigue vivo hasta que el staff lo rechace.
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'release_reserved_balance',
      expect.anything(),
    );
  });

  it('si Bridge responde "must be at least", el mensaje lo explica y vuelve a revisión', async () => {
    const supabase = makeSupabase({ order: pendingOrder() });
    const bridgePost = jest
      .fn()
      .mockRejectedValue(new BridgeSourceAmountTooLowError(1200.5));
    const { service } = makeService(supabase, { bridgePost });

    await expect(
      service.approveOrderReviewStep(ORDER_ID, 'staff-1', {}),
    ).rejects.toThrow(/1200\.5/);
    const statuses = supabase.__updates['payment_orders'].map(
      (u: any) => u.status,
    );
    expect(statuses).toContain('pending_review');
  });

  it('expedientes previos al cambio (sin fx_mode) mantienen el formato anterior', async () => {
    const supabase = makeSupabase({
      order: pendingOrder({
        fx_mode: undefined,
        destination_amount: undefined,
        client_rate: undefined,
      }),
    });
    const { service, bridgePost } = makeService(supabase);

    await service.approveOrderReviewStep(ORDER_ID, 'staff-1', {});

    const [, body, key] = bridgePost.mock.calls[0];
    expect(key).toBe(`po_w2f_${ORDER_ID}`);
    expect(body.amount).toBe(QUOTE.source_amount.toFixed(2));
    expect(body.source.amount).toBeUndefined();
    expect(body.destination.amount).toBeUndefined();
  });

  it('si Bridge no da la tasa en vivo al aprobar, no envía nada y pide reintentar', async () => {
    const supabase = makeSupabase({ order: pendingOrder() });
    const { service, bridgePost } = makeService(supabase, {
      liveRateFails: true,
    });

    await expect(
      service.approveOrderReviewStep(ORDER_ID, 'staff-1', {}),
    ).rejects.toThrow(/No se envió la transferencia.*Reintenta la aprobación/);
    expect(bridgePost).not.toHaveBeenCalled();
    const statuses = supabase.__updates['payment_orders'].map(
      (u: any) => u.status,
    );
    expect(statuses).toContain('pending_review');
  });

  it('si Bridge no da la tasa en vivo al crear, no se reserva saldo', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase, { liveRateFails: true });

    await expect(
      service.createBridgeWalletToFiatUs(
        'user-1',
        { ...baseDto, amount: QUOTE.source_amount, destination_amount: 1000 },
        { skipReviewGate: false },
      ),
    ).rejects.toThrow(/tipo de cambio/i);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('solicitud por exceso de límite: si la tasa empeoró, el mensaje le dice al staff que la rechace', async () => {
    const supabase = makeSupabase();
    // La tasa cayó 2% desde que el cliente envió la solicitud.
    const { service } = makeService(supabase, { liveSell: SELL * 0.98 });

    await expect(
      service.createBridgeWalletToFiatUs(
        'user-1',
        { ...baseDto, amount: QUOTE.source_amount, destination_amount: 1000 },
        { skipReviewGate: true, fromLimitReview: true },
      ),
    ).rejects.toThrow(
      /Rechaza la solicitud para que el cliente vuelva a cotizar/,
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('createWalletRampOrderBypassLimit marca la cotización como proveniente de una solicitud', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);
    const spy = jest
      .spyOn(service, 'createBridgeWalletToFiatUs')
      .mockResolvedValue({ id: ORDER_ID });

    await service.createWalletRampOrderBypassLimit('user-1', {
      ...baseDto,
      amount: QUOTE.source_amount,
      destination_amount: 1000,
    });

    expect(spy).toHaveBeenCalledWith(
      'user-1',
      expect.anything(),
      expect.objectContaining({ skipReviewGate: true, fromLimitReview: true }),
    );
  });

  it('BridgeSourceAmountTooLowError sigue siendo un BadGateway (no rompe ALTO-02)', () => {
    const err = new BridgeSourceAmountTooLowError(99.99);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(err.minimumSourceAmount).toBe(99.99);
  });
});

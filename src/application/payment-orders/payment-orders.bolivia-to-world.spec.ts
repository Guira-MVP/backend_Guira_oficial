import { BadRequestException } from '@nestjs/common';
import { PaymentOrdersService } from './payment-orders.service';
import { resolveBoOutFeeRail } from '../../common/constants/fiat-rail-catalog.constants';

/**
 * bolivia_to_world se ejecuta SIEMPRE por Bridge Transfer con monto de destino
 * fijo (Fixed Outputs). Lo que se protege aquí:
 *   1. La comisión sale de fees_config/override (no de la LA), en USD, y se
 *      congela en fee_amount (BOB) y developer_fee_usd.
 *   2. amount_destination se redondea hacia abajo.
 *   3. La tasa del cliente solo se honra dentro de la tolerancia.
 *   4. Al aprobar, el Transfer lleva destination.amount + developer_fee +
 *      allow_any_from_address y NO lleva amount raíz.
 *   5. Si Bridge falla, la orden vuelve a deposit_received.
 */
describe('PaymentOrdersService — bolivia_to_world (Fixed Outputs)', () => {
  const USER_ID = 'user-1';
  const ORDER_ID = '3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c';

  // BOB_MXN ≈ 0.704717 BOB por MXN; BOB_USD ≈ 12.272055 BOB por USD.
  const RATES: Record<string, number> = {
    BOB_MXN: 0.704717,
    BOB_USD: 12.272055,
  };

  function makeSupabase(
    opts: {
      supplier?: Record<string, unknown>;
      order?: Record<string, unknown>;
    } = {},
  ) {
    const inserts: Record<string, any[]> = {};
    const updates: Record<string, any[]> = {};
    const supplier = opts.supplier ?? {
      id: 'sup-1',
      name: 'Proveedor MX',
      payment_rail: 'spei',
      bank_details: { account_number: '012345678901234567' },
      bridge_liquidation_address_id: null,
      compliance_status: 'approved',
    };

    const tableData: Record<string, any> = {
      bridge_external_accounts: {
        id: 'ea-local-1',
        currency: 'mxn',
        bank_name: 'BBVA',
        account_name: 'Proveedor MX',
        bridge_external_account_id: 'ea_bridge_1',
      },
      suppliers: supplier,
      profiles: {
        bridge_customer_id: 'cus_123',
        onboarding_status: 'approved',
      },
    };

    const from = jest.fn((table: string) => {
      const query: any = {
        __isUpdate: false,
        __inserted: undefined,
        select: jest.fn(() => query),
        insert: jest.fn((payload: unknown) => {
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
        ilike: jest.fn(() => query),
        in: jest.fn(() => query),
        is: jest.fn(() => query),
        or: jest.fn(() => query),
        order: jest.fn(() => query),
        limit: jest.fn(() => query),
        single: jest.fn().mockImplementation(async () => {
          if (query.__inserted) {
            return { data: { id: ORDER_ID, ...query.__inserted }, error: null };
          }
          if (table === 'payment_orders') {
            return { data: opts.order ?? null, error: null };
          }
          return { data: tableData[table], error: null };
        }),
        maybeSingle: jest.fn().mockImplementation(async () => {
          if (table === 'payment_orders' || table === 'bridge_transfers') {
            return { data: null, error: null };
          }
          return { data: tableData[table], error: null };
        }),
      };
      return query;
    });

    return { from, rpc: jest.fn(), __inserts: inserts, __updates: updates };
  }

  function makeService(
    supabase: any,
    opts: { feeUsd?: number; bridgePost?: jest.Mock } = {},
  ) {
    const calculateFee = jest.fn(async (..._args: unknown[]) => ({
      fee_amount: opts.feeUsd ?? 17.95,
      net_amount: 0,
    }));
    const assertFeeConfigured = jest.fn().mockResolvedValue(undefined);
    const getRate = jest.fn(async (pair: string) => ({
      effective_rate: RATES[pair],
    }));
    const bridgePost =
      opts.bridgePost ??
      jest.fn().mockResolvedValue({
        id: 'tr_1',
        state: 'awaiting_funds',
        amount: '599.10',
        source_deposit_instructions: {
          payment_rail: 'solana',
          currency: 'usdc',
          amount: '599.10',
          to_address: 'SoLaNaDepositAddr111111111111111111111111',
        },
      });

    const service = new PaymentOrdersService(
      supabase,
      { calculateFee, assertFeeConfigured, getFeePercent: jest.fn() } as any,
      {
        getDepositAccountForUser: jest.fn().mockResolvedValue({ id: 'psav-1' }),
        formatDepositInstructions: jest.fn().mockReturnValue({ bank: 'PSAV' }),
      } as any,
      { getRate } as any,
      { post: bridgePost } as any,
      {} as any,
      {} as any,
      { sendNotification: jest.fn() } as any,
      { emitOrderCreated: jest.fn(), emitOrderUpdated: jest.fn() } as any,
      {} as any,
      {} as any,
      { requiresReview: jest.fn().mockResolvedValue(false) } as any,
      { assertUsableForPayment: jest.fn() } as any,
    ) as any;

    return { service, calculateFee, assertFeeConfigured, bridgePost };
  }

  const baseDto = {
    flow_type: 'bolivia_to_world',
    amount: 7265.13,
    external_account_id: 'ea-local-1',
    supplier_id: 'sup-1',
    destination_currency: 'mxn',
    business_purpose: 'Pago a proveedor',
  };

  // ── Riel de la tarifa ──

  it('resolveBoOutFeeRail: USD distingue ACH/Wire, el resto usa psav', () => {
    expect(resolveBoOutFeeRail('usd', 'ach')).toBe('ach');
    expect(resolveBoOutFeeRail('USD', 'wire')).toBe('wire');
    expect(resolveBoOutFeeRail('mxn', 'spei')).toBe('psav');
    expect(resolveBoOutFeeRail('eur', 'sepa')).toBe('psav');
    expect(resolveBoOutFeeRail('usd', null)).toBe('psav');
  });

  // ── Creación ──

  it('congela la comisión de fees_config en BOB y USD, sin tocar la LA', async () => {
    const supabase = makeSupabase();
    const { service, calculateFee, assertFeeConfigured } = makeService(
      supabase,
      {
        feeUsd: 17.95,
      },
    );

    await service.createBoliviaToWorld(
      USER_ID,
      { ...baseDto },
      { skipReviewGate: true },
    );

    expect(assertFeeConfigured).toHaveBeenCalledWith(
      USER_ID,
      'interbank_bo_out',
      'psav',
      'mxn',
    );
    const grossUsdArg = calculateFee.mock.calls[0][4] as number;
    expect(grossUsdArg).toBeCloseTo(7265.13 / RATES.BOB_USD, 6);

    const row = supabase.__inserts.payment_orders[0];
    expect(row.fee_source).toBe('bridge_transfer');
    expect(row.bridge_liquidation_address_id).toBeNull();
    expect(row.bridge_liquidation_fee_percent).toBeNull();
    expect(row.developer_fee_usd).toBe(17.95);
    // 17.95 USD × 12.272055 = 220.2834 → 220.28 BOB
    expect(row.fee_amount).toBe(220.28);
    expect(row.net_amount).toBe(7044.85);
    // 7044.85 / 0.704717 = 9996.7055… → hacia abajo
    expect(row.amount_destination).toBe(9996.7);
    expect(row.exchange_rate_applied).toBe(RATES.BOB_MXN);
  });

  it('usa la fila wire/usd para proveedores Wire', async () => {
    const supabase = makeSupabase({
      supplier: {
        id: 'sup-1',
        name: 'US Wire',
        payment_rail: 'wire',
        bank_details: {},
      },
    });
    const { service, assertFeeConfigured } = makeService(supabase);

    await service.createBoliviaToWorld(
      USER_ID,
      { ...baseDto, destination_currency: 'usd' },
      { skipReviewGate: true },
    );

    expect(assertFeeConfigured).toHaveBeenCalledWith(
      USER_ID,
      'interbank_bo_out',
      'wire',
      'usd',
    );
  });

  it('honra la tasa del cliente dentro de la tolerancia', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);
    const clientRate = RATES.BOB_MXN * 0.995;

    await service.createBoliviaToWorld(
      USER_ID,
      { ...baseDto, exchange_rate_applied: clientRate },
      { skipReviewGate: true },
    );

    expect(supabase.__inserts.payment_orders[0].exchange_rate_applied).toBe(
      clientRate,
    );
  });

  it('rechaza una tasa del cliente más favorable que la tolerancia', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);

    await expect(
      service.createBoliviaToWorld(
        USER_ID,
        { ...baseDto, exchange_rate_applied: RATES.BOB_MXN * 0.98 },
        { skipReviewGate: true },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(supabase.__inserts.payment_orders).toBeUndefined();
  });

  // ── Aprobación ──

  const depositReceivedOrder = {
    id: ORDER_ID,
    user_id: USER_ID,
    flow_type: 'bolivia_to_world',
    status: 'deposit_received',
    requires_psav: true,
    supplier_id: 'sup-1',
    external_account_id: 'ea-local-1',
    destination_currency: 'mxn',
    amount: '7265.13',
    currency: 'BOB',
    fee_amount: '220.29',
    developer_fee_usd: '17.95',
    amount_destination: '10000.00',
    exchange_rate_applied: String(RATES.BOB_MXN),
    fee_source: 'bridge_transfer',
    notes: null,
  };

  it('crea el Transfer con destination.amount, developer_fee y allow_any_from_address', async () => {
    const supabase = makeSupabase({ order: depositReceivedOrder });
    const { service, bridgePost } = makeService(supabase);

    const result = await service.approveOrder(ORDER_ID, 'staff-1', {});

    expect(bridgePost).toHaveBeenCalledTimes(1);
    const [path, body, idempotencyKey] = bridgePost.mock.calls[0];
    expect(path).toBe('/v0/transfers');
    expect(idempotencyKey).toBe(`po_b2w_${ORDER_ID}`);
    expect(body).toEqual({
      on_behalf_of: 'cus_123',
      source: { payment_rail: 'solana', currency: 'usdc' },
      destination: {
        payment_rail: 'spei',
        currency: 'mxn',
        external_account_id: 'ea_bridge_1',
        amount: '10000.00',
        spei_reference: 'Guira 3F9A2C1E',
      },
      developer_fee: '17.95',
      client_reference_id: ORDER_ID,
      features: { allow_any_from_address: true },
    });
    expect(body).not.toHaveProperty('amount');

    expect(result.bridge_transfer_id).toBe('tr_1');
    expect(result.bridge_source_deposit_instructions).toMatchObject({
      type: 'bridge_transfer',
      amount_to_deposit: 599.1,
      to_address: 'SoLaNaDepositAddr111111111111111111111111',
      destination_amount: 10000,
      developer_fee_usd: 17.95,
    });
  });

  it('si Bridge falla, revierte la orden a deposit_received', async () => {
    const supabase = makeSupabase({ order: depositReceivedOrder });
    const bridgePost = jest
      .fn()
      .mockRejectedValue(new Error('invalid_parameters'));
    const { service } = makeService(supabase, { bridgePost });

    await expect(service.approveOrder(ORDER_ID, 'staff-1', {})).rejects.toThrow(
      BadRequestException,
    );

    const orderUpdates = supabase.__updates.payment_orders;
    expect(orderUpdates[orderUpdates.length - 1]).toEqual({
      status: 'deposit_received',
    });
  });
});

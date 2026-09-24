import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentOrdersService } from './payment-orders.service';

/**
 * Plazo de depósito de los flujos PSAV + indicador de margen de bolivia_to_world.
 *
 * Lo que se protege aquí:
 *   1. El plazo arranca al publicar la cuenta de depósito (no en pending_review).
 *   2. Un comprobante fuera de plazo se rechaza y no revive una orden cancelada.
 *   3. El cron cancela con compare-and-set, avisa al cliente y al staff, y no
 *      cancela si Bridge rechaza borrar el transfer.
 *   4. Aprobar un bolivia_to_world con margen negativo exige confirmación.
 */
describe('PaymentOrdersService — plazo de depósito y margen', () => {
  const ORDER_ID = '3f9a2c1e-7b4d-4e8a-9c21-5d6e7f8a9b0c';

  type Resolver = (table: string, q: any) => { data: any; error?: any };

  /** Supabase mínimo: registra cada operación y resuelve con `resolve`. */
  function makeSupabase(resolve: Resolver) {
    const ops: Array<{
      table: string;
      kind: string;
      payload?: any;
      filters: any[];
    }> = [];
    const from = jest.fn((table: string) => {
      const q: any = { table, kind: 'select', payload: undefined, filters: [] };
      const chain = (name: string) =>
        jest.fn((...args: unknown[]) => {
          q.filters.push([name, ...args]);
          return q;
        });
      q.select = jest.fn(() => q);
      q.insert = jest.fn((payload: unknown) => {
        q.kind = 'insert';
        q.payload = payload;
        ops.push({ table, kind: 'insert', payload, filters: q.filters });
        return q;
      });
      q.update = jest.fn((payload: unknown) => {
        q.kind = 'update';
        q.payload = payload;
        ops.push({ table, kind: 'update', payload, filters: q.filters });
        return q;
      });
      for (const m of [
        'eq',
        'in',
        'lt',
        'is',
        'or',
        'order',
        'limit',
        'ilike',
        'neq',
        'not',
      ]) {
        q[m] = chain(m);
      }
      const settle = async () => ({ error: null, ...resolve(table, q) });
      q.single = jest.fn(settle);
      q.maybeSingle = jest.fn(settle);
      q.then = (ok: any, ko: any) => settle().then(ok, ko);
      return q;
    });
    return { from, rpc: jest.fn(), ops };
  }

  function makeService(
    supabase: any,
    opts: {
      rates?: Record<string, any>;
      bridgeDelete?: jest.Mock;
      bridgePost?: jest.Mock;
    } = {},
  ) {
    const sendNotification = jest.fn().mockResolvedValue(undefined);
    const emitOrderUpdated = jest.fn();
    const rates = opts.rates ?? {};
    const service = new PaymentOrdersService(
      supabase,
      {
        calculateFee: jest.fn(),
        assertFeeConfigured: jest.fn(),
        getFeePercent: jest.fn(),
      } as any,
      {
        getDepositAccountForUser: jest.fn().mockResolvedValue({ id: 'psav-1' }),
        formatDepositInstructions: jest.fn().mockReturnValue({ bank: 'PSAV' }),
      } as any,
      {
        getRate: jest.fn(async (pair: string) => {
          if (!rates[pair]) throw new Error(`sin tasa ${pair}`);
          return rates[pair];
        }),
      } as any,
      {
        delete: opts.bridgeDelete ?? jest.fn().mockResolvedValue({}),
        post:
          opts.bridgePost ??
          jest.fn().mockResolvedValue({
            id: 'tr_1',
            state: 'awaiting_funds',
            source_deposit_instructions: {
              amount: '594.88',
              to_address: 'Sol1',
            },
          }),
      } as any,
      {} as any,
      {} as any,
      { sendNotification } as any,
      { emitOrderCreated: jest.fn(), emitOrderUpdated } as any,
      {} as any,
      {} as any,
      { requiresReview: jest.fn() } as any,
      { assertUsableForPayment: jest.fn() } as any,
    ) as any;
    return { service, sendNotification, emitOrderUpdated };
  }

  const settingRow = (value: string | null) => (table: string) =>
    table === 'app_settings'
      ? { data: value == null ? null : { value } }
      : null;

  // ── 1. Arranque del plazo ──

  describe('resolveDepositDeadline', () => {
    it('usa PSAV_DEPOSIT_EXPIRY_MINUTES de app_settings', async () => {
      const supabase = makeSupabase(
        (t) => settingRow('15')(t) ?? { data: null },
      );
      const { service } = makeService(supabase);
      const before = Date.now();
      const deadline = new Date(
        await service.resolveDepositDeadline(),
      ).getTime();
      expect(deadline - before).toBeGreaterThanOrEqual(15 * 60_000 - 50);
      expect(deadline - before).toBeLessThanOrEqual(15 * 60_000 + 1000);
    });

    it('cae a 10 minutos si el valor falta o es inválido', async () => {
      for (const value of [null, 'abc', '0', '-5']) {
        const supabase = makeSupabase(
          (t) => settingRow(value)(t) ?? { data: null },
        );
        const { service } = makeService(supabase);
        const delta =
          new Date(await service.resolveDepositDeadline()).getTime() -
          Date.now();
        expect(Math.round(delta / 60_000)).toBe(10);
      }
    });
  });

  it('executePsavDepositLeg publica la cuenta y arranca el plazo', async () => {
    const supabase = makeSupabase((t) => settingRow('10')(t) ?? { data: null });
    const { service } = makeService(supabase);
    const order: any = { id: ORDER_ID, user_id: 'user-1' };

    const result = await service.executePsavDepositLeg(
      order,
      { kind: 'psav_deposit', psav_type: 'bank_bo', psav_currency: 'BOB' },
      { onFailure: 'return_to_review' },
    );

    expect(result.status).toBe('waiting_deposit');
    const update = supabase.ops.find(
      (o) => o.table === 'payment_orders' && o.kind === 'update',
    )!;
    expect(update.payload.status).toBe('waiting_deposit');
    expect(typeof update.payload.deposit_expires_at).toBe('string');
    expect(order.deposit_expires_at).toBe(update.payload.deposit_expires_at);
  });

  // ── 2. Comprobante ──

  describe('confirmDeposit', () => {
    const waiting = (expiresAt: string | null) => ({
      id: ORDER_ID,
      user_id: 'user-1',
      status: 'waiting_deposit',
      requires_psav: true,
      notes: null,
      deposit_expires_at: expiresAt,
    });

    it('rechaza un comprobante fuera de plazo sin tocar la orden', async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const supabase = makeSupabase((t) =>
        t === 'payment_orders' ? { data: waiting(past) } : { data: null },
      );
      const { service } = makeService(supabase);

      await expect(
        service.confirmDeposit('user-1', ORDER_ID, { deposit_proof_url: 'x' }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'DEPOSIT_EXPIRED' }),
      });
      expect(supabase.ops.filter((o) => o.kind === 'update')).toHaveLength(0);
    });

    it('si el cron ganó la carrera, responde ORDER_STATE_CHANGED', async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const supabase = makeSupabase((t, q) => {
        if (t !== 'payment_orders') return { data: null };
        // La lectura ve waiting_deposit; el UPDATE con CAS no encuentra fila.
        return { data: q.kind === 'update' ? null : waiting(future) };
      });
      const { service } = makeService(supabase);

      await expect(
        service.confirmDeposit('user-1', ORDER_ID, { deposit_proof_url: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
      const update = supabase.ops.find((o) => o.kind === 'update')!;
      expect(update.filters).toContainEqual([
        'eq',
        'status',
        'waiting_deposit',
      ]);
    });
  });

  // ── 3. Cron de vencimiento ──

  describe('expireOverdueDepositOrders', () => {
    const overdue = (extra: Record<string, unknown> = {}) => ({
      id: ORDER_ID,
      user_id: 'user-1',
      flow_type: 'bolivia_to_world',
      amount: 7265.12,
      currency: 'BOB',
      status: 'waiting_deposit',
      bridge_transfer_id: null,
      deposit_reference_code: 'G-24092026-123456',
      ...extra,
    });

    function cronSupabase(order: any, opts: { casWins?: boolean } = {}) {
      const casWins = opts.casWins ?? true;
      return makeSupabase((t, q) => {
        if (t === 'payment_orders' && q.kind === 'select')
          return { data: [order] };
        if (t === 'payment_orders' && q.kind === 'update') {
          return { data: casWins ? { ...order, status: 'cancelled' } : null };
        }
        if (t === 'profiles') return { data: [{ id: 'staff-1' }] };
        return { data: null };
      });
    }

    it('cancela como system, revierte ledgers pendientes y avisa a cliente y staff', async () => {
      const supabase = cronSupabase(overdue());
      const { service, sendNotification, emitOrderUpdated } =
        makeService(supabase);

      await service.expireOverdueDepositOrders();

      const cancel = supabase.ops.find(
        (o) => o.table === 'payment_orders' && o.kind === 'update',
      )!;
      expect(cancel.payload).toMatchObject({
        status: 'cancelled',
        cancelled_by: null,
        cancelled_by_role: 'system',
        cancellation_reason: 'Plazo de depósito vencido',
      });
      expect(cancel.filters).toContainEqual([
        'eq',
        'status',
        'waiting_deposit',
      ]);

      expect(
        supabase.ops.find(
          (o) => o.table === 'ledger_entries' && o.kind === 'update',
        )?.payload,
      ).toEqual({ status: 'reversed' });
      expect(
        supabase.ops.find((o) => o.table === 'audit_logs')?.payload,
      ).toMatchObject({ action: 'EXPIRE_DEPOSIT_ORDER', source: 'cron' });

      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          title: 'Expediente cancelado',
        }),
      );
      const staffNotif = supabase.ops.find((o) => o.table === 'notifications');
      expect(JSON.stringify(staffNotif?.payload)).toContain(
        'G-24092026-123456',
      );
      expect(emitOrderUpdated).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ status: 'cancelled' }),
      );
    });

    it('si el comprobante llegó antes (CAS perdido) no avisa ni revierte nada', async () => {
      const supabase = cronSupabase(overdue(), { casWins: false });
      const { service, sendNotification } = makeService(supabase);

      await service.expireOverdueDepositOrders();

      expect(sendNotification).not.toHaveBeenCalled();
      expect(
        supabase.ops.find((o) => o.table === 'ledger_entries'),
      ).toBeUndefined();
      expect(
        supabase.ops.find((o) => o.table === 'audit_logs'),
      ).toBeUndefined();
    });

    it('fiat_bo on-ramp: si Bridge rechaza el DELETE no cancela, quita el plazo y escala', async () => {
      const order = overdue({
        flow_type: 'fiat_bo_to_bridge_wallet',
        bridge_transfer_id: 'tr_9',
      });
      const supabase = cronSupabase(order);
      const bridgeDelete = jest.fn().mockRejectedValue(new Error('409'));
      const { service, sendNotification } = makeService(supabase, {
        bridgeDelete,
      });

      await service.expireOverdueDepositOrders();

      expect(bridgeDelete).toHaveBeenCalledWith('/v0/transfers/tr_9');
      const updates = supabase.ops.filter(
        (o) => o.table === 'payment_orders' && o.kind === 'update',
      );
      expect(updates).toHaveLength(1);
      expect(updates[0].payload).toEqual({ deposit_expires_at: null });
      expect(sendNotification).not.toHaveBeenCalled();
      expect(
        supabase.ops.find((o) => o.table === 'notifications'),
      ).toBeDefined();
    });
  });

  // ── 4. Margen al aprobar ──

  describe('margen de bolivia_to_world', () => {
    // Escenarios del análisis: 10.000 MXN, cliente pagó 7.265,12 BOB,
    // developer_fee 17,76 USD, BOB_USD base 12,211.
    const order = {
      id: ORDER_ID,
      user_id: 'user-1',
      flow_type: 'bolivia_to_world',
      status: 'deposit_received',
      requires_psav: true,
      supplier_id: 'sup-1',
      external_account_id: 'ea-1',
      destination_currency: 'mxn',
      amount: '7265.12',
      currency: 'BOB',
      fee_amount: '217.95',
      developer_fee_usd: '17.76',
      amount_destination: '10000.00',
      exchange_rate_applied: '0.704717',
      notes: null,
    };
    const ratesWith = (usdMxnSell: number) => ({
      BOB_USD: { base_rate: 12.211, effective_rate: 12.272055 },
      USD_MXN: { base_rate: usdMxnSell, bridge_sell_rate: usdMxnSell },
    });

    it('escenario A (tasas estables) ≈ +288 BOB', async () => {
      const supabase = makeSupabase(() => ({ data: null }));
      const { service } = makeService(supabase, {
        rates: ratesWith(17.500777),
      });
      const est = await service.estimateBoliviaToWorldMargin(order);
      expect(est.margin_bob).toBeCloseTo(287.72, 0);
      expect(est.usdc_to_deposit_estimate).toBeCloseTo(594.88, 1);
    });

    it('escenario C (peso +5%) ≈ −80 BOB', async () => {
      const supabase = makeSupabase(() => ({ data: null }));
      const { service } = makeService(supabase, {
        rates: ratesWith(17.500777 * 0.95),
      });
      const est = await service.estimateBoliviaToWorldMargin(order);
      expect(est.margin_bob).toBeCloseTo(-79.52, 0);
    });

    function approveSupabase() {
      return makeSupabase((t, q) => {
        if (t === 'payment_orders') {
          // Consulta de colisión de dirección de depósito (lleva .neq): sin
          // otros Transfers activos del cliente.
          if (q.filters.some((f: any[]) => f[0] === 'neq')) return { data: [] };
          return {
            data:
              q.kind === 'update' ? { ...order, status: 'processing' } : order,
          };
        }
        if (t === 'suppliers')
          return { data: { id: 'sup-1', name: 'MX', payment_rail: 'spei' } };
        if (t === 'profiles')
          return { data: { bridge_customer_id: 'cus_1', role: 'staff' } };
        if (t === 'bridge_external_accounts') {
          return { data: { bridge_external_account_id: 'ea_bridge' } };
        }
        return { data: null };
      });
    }

    it('con margen negativo y sin confirmación responde NEGATIVE_MARGIN sin tocar la orden', async () => {
      const supabase = approveSupabase();
      const { service } = makeService(supabase, {
        rates: ratesWith(17.500777 * 0.95),
      });

      await expect(
        service.approveOrder(ORDER_ID, 'staff-1', {}),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'NEGATIVE_MARGIN' }),
      });
      expect(
        supabase.ops.filter(
          (o) => o.table === 'payment_orders' && o.kind === 'update',
        ),
      ).toHaveLength(0);
    });

    it('con confirmación aprueba y deja el margen en la auditoría', async () => {
      const supabase = approveSupabase();
      const bridgePost = jest.fn().mockResolvedValue({
        id: 'tr_1',
        state: 'awaiting_funds',
        source_deposit_instructions: { amount: '625.25', to_address: 'Sol1' },
      });
      const { service } = makeService(supabase, {
        rates: ratesWith(17.500777 * 0.95),
        bridgePost,
      });

      await service.approveOrder(ORDER_ID, 'staff-1', {
        acknowledge_negative_margin: true,
      });

      expect(bridgePost).toHaveBeenCalledTimes(1);
      const audit = supabase.ops.find(
        (o) =>
          o.table === 'audit_logs' &&
          o.payload?.action === 'APPROVE_PAYMENT_ORDER',
      );
      expect(audit?.payload.new_values).toMatchObject({
        acknowledged_negative_margin: true,
      });
      expect(audit?.payload.new_values.estimated_margin_bob).toBeLessThan(0);
    });

    it('con margen positivo aprueba sin pedir confirmación', async () => {
      const supabase = approveSupabase();
      const { service } = makeService(supabase, {
        rates: ratesWith(17.500777),
      });

      await expect(
        service.approveOrder(ORDER_ID, 'staff-1', {}),
      ).resolves.toBeDefined();
    });

    it('rechaza estimar el margen de otros flujos', async () => {
      const supabase = makeSupabase((t) =>
        t === 'payment_orders'
          ? { data: { ...order, flow_type: 'bolivia_to_wallet' } }
          : { data: null },
      );
      const { service } = makeService(supabase);
      await expect(
        service.getBoliviaToWorldMarginEstimate(ORDER_ID),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

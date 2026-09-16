import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentOrdersService } from './payment-orders.service';
import {
  evaluateClientCancellation,
  evaluateStaffCancellation,
  resolveCancellationGroup,
} from './cancellation-policy';

type TableResults = {
  select?: unknown;
  update?: unknown;
  insert?: unknown;
};

/**
 * Mock encadenable de supabase-js. Distingue la operación (select/update/insert)
 * para que una misma tabla pueda devolver la orden en el SELECT y el resultado
 * del compare-and-set en el UPDATE.
 */
const createTableMock = (results: TableResults) => {
  const chains: any[] = [];

  const factory = () => {
    let op: keyof TableResults = 'select';
    const chain: any = {};

    for (const method of [
      'select',
      'eq',
      'in',
      'or',
      'not',
      'limit',
      'order',
      'gte',
      'lt',
      'range',
    ]) {
      chain[method] = jest.fn(() => chain);
    }

    chain.update = jest.fn(() => {
      op = 'update';
      return chain;
    });
    chain.insert = jest.fn(() => {
      op = 'insert';
      return chain;
    });
    chain.delete = jest.fn(() => chain);

    const resolveResult = () => results[op] ?? { data: null, error: null };

    chain.single = jest.fn(() => Promise.resolve(resolveResult()));
    chain.maybeSingle = jest.fn(() => Promise.resolve(resolveResult()));
    chain.then = (onOk: any, onErr: any) =>
      Promise.resolve(resolveResult()).then(onOk, onErr);

    chains.push(chain);
    return chain;
  };

  factory.chains = chains;
  return factory;
};

const createSupabase = (
  tables: Record<string, ReturnType<typeof createTableMock>>,
) => {
  const fallback = createTableMock({});
  const supabase: any = {
    from: jest.fn((table: string) => (tables[table] ?? fallback)()),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
  };
  supabase.tables = tables;
  return supabase;
};

const createService = (supabase: any, bridgeApi: any = {}) =>
  new PaymentOrdersService(
    supabase,
    {} as any, // feesService
    {} as any, // psavService
    {} as any, // exchangeRatesService
    bridgeApi,
    {} as any, // bankAccountsService
    {} as any, // orderReviewService
    {} as any, // notificationsService
    { emitOrderUpdated: jest.fn() } as any,
    {} as any, // emailService
    {} as any, // pdfService
    // Switch por flujo de la puerta de revisión: estos tests ejercitan
    // cancelaciones sobre expedientes ya creados, así que nunca se consulta.
    { requiresReview: jest.fn().mockResolvedValue(true) } as any,
    // suppliersService: el guard de cumplimiento no aplica en estos tests
    // (ningún beneficiario está bloqueado), así que es un no-op.
    { assertUsableForPayment: jest.fn() } as any,
  );

const buildOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-1',
  user_id: 'user-1',
  status: 'waiting_deposit',
  flow_type: 'wallet_to_wallet',
  amount: 1000,
  fee_amount: 10,
  currency: 'USDC',
  wallet_id: 'wallet-1',
  bridge_transfer_id: 'bt-1',
  ...overrides,
});

/** Escenario estándar: la orden existe y el CAS de cancelación gana. */
const scenario = (
  order: Record<string, unknown>,
  casResult: unknown = { data: { ...order, status: 'cancelled' }, error: null },
) => {
  const paymentOrders = createTableMock({
    select: { data: order, error: null },
    update: casResult,
  });
  const notifications = createTableMock({
    insert: { data: null, error: null },
  });
  const profiles = createTableMock({
    select: { data: [{ id: 'staff-1' }], error: null },
  });

  return {
    paymentOrders,
    notifications,
    profiles,
    supabase: createSupabase({
      payment_orders: paymentOrders,
      notifications,
      profiles,
      ledger_entries: createTableMock({
        select: { data: [], error: null },
        update: { data: [], error: null },
      }),
      bridge_transfers: createTableMock({
        update: { data: null, error: null },
      }),
      audit_logs: createTableMock({ insert: { data: null, error: null } }),
      activity_logs: createTableMock({ insert: { data: null, error: null } }),
    }),
  };
};

describe('cancellation-policy', () => {
  it('agrupa los 10 flujos auditados y deja fuera los desconocidos', () => {
    expect(resolveCancellationGroup('bolivia_to_world')).toBe('fiat_in_bo');
    expect(resolveCancellationGroup('bolivia_to_wallet')).toBe('fiat_in_bo');
    expect(resolveCancellationGroup('world_to_bolivia')).toBe('fiat_in_bo');
    expect(resolveCancellationGroup('fiat_bo_to_bridge_wallet')).toBe(
      'fiat_in_bo',
    );

    expect(resolveCancellationGroup('wallet_to_wallet')).toBe('crypto_in');
    expect(resolveCancellationGroup('wallet_to_world')).toBe('crypto_in');
    expect(resolveCancellationGroup('crypto_to_bridge_wallet')).toBe(
      'crypto_in',
    );

    expect(resolveCancellationGroup('bridge_wallet_to_fiat_bo')).toBe(
      'wallet_ramp_out',
    );
    expect(resolveCancellationGroup('bridge_wallet_to_crypto')).toBe(
      'wallet_ramp_out',
    );
    expect(resolveCancellationGroup('bridge_wallet_to_fiat_us')).toBe(
      'wallet_ramp_out',
    );

    // va_deposit no está en la matriz: por seguridad no es cancelable.
    expect(resolveCancellationGroup('va_deposit')).toBeNull();
  });

  it('bloquea al cliente en todos los estados de los flujos wallet-ramp', () => {
    for (const flow of [
      'bridge_wallet_to_fiat_bo',
      'bridge_wallet_to_crypto',
      'bridge_wallet_to_fiat_us',
    ]) {
      for (const status of ['created', 'processing', 'sent']) {
        const decision = evaluateClientCancellation({
          flow_type: flow,
          status,
        });
        expect(decision.allowed).toBe(false);
      }
    }
  });

  it('bloquea los estados terminales en cualquier flujo', () => {
    for (const status of [
      'completed',
      'failed',
      'cancelled',
      'refunded',
      'swept_external',
    ]) {
      expect(
        evaluateClientCancellation({ flow_type: 'wallet_to_wallet', status })
          .reason_code,
      ).toBe('TERMINAL_STATUS');
    }
  });

  it('en cripto-in solo permite cancelar con el transfer en awaiting_funds', () => {
    const base = { flow_type: 'wallet_to_world', status: 'waiting_deposit' };

    expect(
      evaluateClientCancellation({ ...base, bridge_state: 'awaiting_funds' })
        .allowed,
    ).toBe(true);
    // Sin transfer creado tampoco hay fondos en juego.
    expect(
      evaluateClientCancellation({ ...base, bridge_state: null }).allowed,
    ).toBe(true);

    for (const state of [
      'funds_received',
      'payment_submitted',
      'in_review',
      'payment_processed',
    ]) {
      const decision = evaluateClientCancellation({
        ...base,
        bridge_state: state,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason_code).toBe('FUNDS_IN_FLIGHT');
    }
  });

  it('permite al cliente cancelar mientras el expediente espera revisión del staff', () => {
    // Es la única ventana provablemente segura de los flujos wallet-ramp: no
    // existe ningún transfer en Bridge todavía, solo una reserva de saldo.
    for (const flow of [
      'bridge_wallet_to_fiat_bo',
      'bridge_wallet_to_crypto',
      'bridge_wallet_to_fiat_us',
      'wallet_to_world',
    ]) {
      expect(
        evaluateClientCancellation({ flow_type: flow, status: 'pending_review' })
          .allowed,
      ).toBe(true);
    }
  });

  it('el staff puede cancelar hasta processing, nunca desde sent', () => {
    for (const status of [
      'created',
      'pending_review',
      'waiting_deposit',
      'deposit_received',
      'processing',
    ]) {
      expect(evaluateStaffCancellation(status).allowed).toBe(true);
    }
    expect(evaluateStaffCancellation('sent').allowed).toBe(false);
    expect(evaluateStaffCancellation('completed').reason_code).toBe(
      'TERMINAL_STATUS',
    );
  });
});

describe('PaymentOrdersService.cancelOrder — flujos cripto-in', () => {
  it('cancela cuando Bridge confirma awaiting_funds y ejecuta el DELETE', async () => {
    const bridgeApi = {
      get: jest.fn().mockResolvedValue({ id: 'bt-1', state: 'awaiting_funds' }),
      delete: jest.fn().mockResolvedValue({}),
    };
    const { supabase } = scenario(buildOrder());
    const service = createService(supabase, bridgeApi);

    const result = await service.cancelOrder('user-1', 'order-1');

    expect(bridgeApi.get).toHaveBeenCalledWith('/v0/transfers/bt-1');
    expect(bridgeApi.delete).toHaveBeenCalledWith('/v0/transfers/bt-1');
    expect(result.status).toBe('cancelled');
  });

  it('rechaza con FUNDS_IN_FLIGHT si Bridge ya recibió los fondos, sin borrar el transfer', async () => {
    const bridgeApi = {
      get: jest.fn().mockResolvedValue({ id: 'bt-1', state: 'funds_received' }),
      delete: jest.fn(),
    };
    const { supabase, paymentOrders } = scenario(buildOrder());
    const service = createService(supabase, bridgeApi);

    await expect(
      service.cancelOrder('user-1', 'order-1'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(bridgeApi.delete).not.toHaveBeenCalled();
    // Ninguna cadena de payment_orders llegó a ejecutar un UPDATE.
    expect(
      paymentOrders.chains.some((c: any) => c.update.mock.calls.length > 0),
    ).toBe(false);
  });

  it('no cancela localmente si Bridge rechaza el DELETE', async () => {
    const bridgeApi = {
      get: jest.fn().mockResolvedValue({ id: 'bt-1', state: 'awaiting_funds' }),
      delete: jest
        .fn()
        .mockRejectedValue(new Error('transfer already processed')),
    };
    const { supabase, paymentOrders } = scenario(buildOrder());
    const service = createService(supabase, bridgeApi);

    await expect(
      service.cancelOrder('user-1', 'order-1'),
    ).rejects.toMatchObject({
      response: { code: 'BRIDGE_DELETE_FAILED' },
    });

    expect(
      paymentOrders.chains.some((c: any) => c.update.mock.calls.length > 0),
    ).toBe(false);
  });

  it('devuelve 503 en vez de cancelar a ciegas si Bridge no responde', async () => {
    const bridgeApi = {
      get: jest.fn().mockRejectedValue(new Error('bridge down')),
      delete: jest.fn(),
    };
    const { supabase } = scenario(buildOrder());
    const service = createService(supabase, bridgeApi);

    await expect(
      service.cancelOrder('user-1', 'order-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(bridgeApi.delete).not.toHaveBeenCalled();
  });
});

describe('PaymentOrdersService.cancelOrder — flujos fiat BO', () => {
  it('exige la declaración de no-depósito', async () => {
    const { supabase } = scenario(
      buildOrder({ flow_type: 'bolivia_to_world', bridge_transfer_id: null }),
    );
    const service = createService(supabase);

    await expect(
      service.cancelOrder('user-1', 'order-1'),
    ).rejects.toMatchObject({
      response: { code: 'DEPOSIT_DECLARATION_REQUIRED' },
    });
  });

  it('cancela con la declaración y avisa a operaciones para conciliar', async () => {
    const order = buildOrder({
      flow_type: 'bolivia_to_world',
      bridge_transfer_id: null,
      currency: 'BOB',
    });
    const { supabase, notifications } = scenario(order);
    const service = createService(supabase);

    const result = await service.cancelOrder('user-1', 'order-1', {
      confirm_no_deposit: true,
    });

    expect(result.status).toBe('cancelled');
    // El aviso a operaciones es fire-and-forget: esperamos un tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      notifications.chains.some((c: any) => c.insert.mock.calls.length > 0),
    ).toBe(true);
  });

  it('guarda la declaración y el motivo del cliente en cancellation_reason', async () => {
    const order = buildOrder({
      flow_type: 'world_to_bolivia',
      bridge_transfer_id: null,
    });
    const { supabase, paymentOrders } = scenario(order);
    const service = createService(supabase);

    await service.cancelOrder('user-1', 'order-1', {
      confirm_no_deposit: true,
      reason: 'Me equivoqué de proveedor',
    });

    const updateCall = paymentOrders.chains
      .flatMap((c: any) => c.update.mock.calls)
      .at(0)?.[0];

    expect(updateCall).toMatchObject({
      status: 'cancelled',
      cancelled_by: 'user-1',
      cancelled_by_role: 'client',
    });
    expect(updateCall.cancellation_reason).toContain(
      'Cliente declaró no haber depositado',
    );
    expect(updateCall.cancellation_reason).toContain(
      'Me equivoqué de proveedor',
    );
    expect(updateCall.cancelled_at).toEqual(expect.any(String));
  });
});

describe('PaymentOrdersService.cancelOrder — flujos wallet-ramp y concurrencia', () => {
  it('bloquea la cancelación de cliente en created y en processing', async () => {
    for (const status of ['created', 'processing']) {
      const { supabase } = scenario(
        buildOrder({ flow_type: 'bridge_wallet_to_crypto', status }),
      );
      const service = createService(supabase);

      await expect(
        service.cancelOrder('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('devuelve ORDER_STATE_CHANGED si el CAS pierde la carrera', async () => {
    const bridgeApi = {
      get: jest.fn().mockResolvedValue({ id: 'bt-1', state: 'awaiting_funds' }),
      delete: jest.fn().mockResolvedValue({}),
    };
    // El UPDATE no afecta filas: el estado cambió entre la lectura y el CAS.
    const { supabase } = scenario(buildOrder(), { data: null, error: null });
    const service = createService(supabase, bridgeApi);

    await expect(
      service.cancelOrder('user-1', 'order-1'),
    ).rejects.toMatchObject({
      response: { code: 'ORDER_STATE_CHANGED' },
    });
  });

  it('no toca saldos cuando el CAS pierde la carrera', async () => {
    const bridgeApi = {
      get: jest.fn().mockResolvedValue({ id: 'bt-1', state: 'awaiting_funds' }),
      delete: jest.fn().mockResolvedValue({}),
    };
    const { supabase } = scenario(buildOrder(), { data: null, error: null });
    const service = createService(supabase, bridgeApi);

    await expect(
      service.cancelOrder('user-1', 'order-1'),
    ).rejects.toBeDefined();

    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe('PaymentOrdersService.cancelOrderByStaff', () => {
  const staffScenario = (order: Record<string, unknown>) => {
    const paymentOrders = createTableMock({
      select: { data: order, error: null },
      update: { data: { ...order, status: 'cancelled' }, error: null },
    });

    return {
      paymentOrders,
      supabase: createSupabase({
        payment_orders: paymentOrders,
        profiles: createTableMock({
          select: { data: { role: 'staff' }, error: null },
        }),
        ledger_entries: createTableMock({
          select: { data: [], error: null },
          update: { data: [], error: null },
        }),
        audit_logs: createTableMock({ insert: { data: null, error: null } }),
        activity_logs: createTableMock({ insert: { data: null, error: null } }),
        notifications: createTableMock({ insert: { data: null, error: null } }),
      }),
    };
  };

  it('cancela desde deposit_received y marca el actor como staff', async () => {
    const { supabase, paymentOrders } = staffScenario(
      buildOrder({ status: 'deposit_received', flow_type: 'bolivia_to_world' }),
    );
    const service = createService(supabase);

    const result = await service.cancelOrderByStaff('order-1', 'staff-1', {
      reason: 'Cliente pidió anular por teléfono',
    });

    expect(result.status).toBe('cancelled');
    const updateCall = paymentOrders.chains
      .flatMap((c: any) => c.update.mock.calls)
      .at(0)?.[0];
    expect(updateCall).toMatchObject({
      status: 'cancelled',
      cancelled_by: 'staff-1',
      cancelled_by_role: 'staff',
      cancellation_reason: 'Cliente pidió anular por teléfono',
    });
  });

  it('no permite cancelar un expediente ya enviado', async () => {
    const { supabase } = staffScenario(buildOrder({ status: 'sent' }));
    const service = createService(supabase);

    await expect(
      service.cancelOrderByStaff('order-1', 'staff-1', { reason: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('con refund=false no libera reservas', async () => {
    const { supabase } = staffScenario(buildOrder({ status: 'processing' }));
    const service = createService(supabase);

    await service.cancelOrderByStaff('order-1', 'staff-1', {
      reason: 'Devolución gestionada por fuera',
      refund: false,
    });

    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

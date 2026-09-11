import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentOrdersService } from './payment-orders.service';
import {
  supportsStaffReviewGate,
  resolvePendingReviewReserve,
} from './staff-review-gate';

/**
 * Tests de la puerta de revisión de staff: el paso obligatorio entre "expediente
 * creado" y "transfer enviado al proveedor".
 *
 * Lo que se protege aquí:
 *   1. Sin aprobación explícita del staff, NUNCA se llama a Bridge.
 *   2. Dos miembros del staff no pueden aprobar el mismo expediente a la vez
 *      (compare-and-set antes de tocar a Bridge).
 *   3. Si Bridge falla al aprobar, el expediente vuelve a revisión, la reserva
 *      NO se libera y el reintento reutiliza la misma Idempotency-Key.
 *   4. Al rechazar, la reserva se devuelve desde bridge_execution_context y NO
 *      escaneando ledger_entries, que en 'pending_review' está vacío.
 *   5. Los flujos sin puerta siguen intactos.
 */
describe('PaymentOrdersService — puerta de revisión de staff', () => {
  const ORDER_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

  const FIAT_BO_CONTEXT = {
    kind: 'bridge_wallet_to_fiat_bo' as const,
    source_currency: 'USDC',
    amount: 1000,
    fee_amount: 30,
    net_amount: 970,
    total_needed: 1000,
    psav_account_id: 'psav-acc-1',
    psav_dest_currency: 'USDC',
  };

  function pendingOrder(overrides: Record<string, unknown> = {}) {
    return {
      id: ORDER_ID,
      user_id: 'user-1',
      wallet_id: 'wallet-1',
      flow_type: 'bridge_wallet_to_fiat_bo',
      status: 'pending_review',
      amount: 1000,
      currency: 'USDC',
      source_currency: 'USDC',
      notes: null,
      bridge_execution_context: FIAT_BO_CONTEXT,
      ...overrides,
    };
  }

  /**
   * @param claimed fila que devuelve el UPDATE con compare-and-set. `null`
   *   simula que otro miembro del staff se adelantó.
   */
  function makeSupabase(order: any, opts: { claimed?: any } = {}) {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
    const ledgerInsert = jest
      .fn()
      .mockResolvedValue({ data: null, error: null });
    const updates: Record<string, any[]> = {};
    const inserts: Record<string, any[]> = {};

    const tableData: Record<string, any> = {
      profiles: {
        bridge_customer_id: 'cus_123',
        role: 'staff',
        email: 'cliente@example.com',
        full_name: 'Cliente',
        // Crear un expediente exige la cuenta verificada
        // (assertOnboardingApproved). Sin esto el mock devuelve undefined y
        // la creación se rechaza antes de llegar a lo que mide este test.
        onboarding_status: 'approved',
      },
      wallets: { id: 'wallet-1', provider_wallet_id: 'bw_1' },
      psav_accounts: {
        id: 'psav-acc-1',
        crypto_address: 'SoLaNaAddr1111111111111111111111111111111',
        crypto_network: 'solana',
        is_active: true,
      },
    };

    const claimed = 'claimed' in opts ? opts.claimed : { ...order, status: 'processing' };

    const from = jest.fn((table: string) => {
      const query: any = {
        __isUpdate: false,
        select: jest.fn(() => query),
        insert: jest.fn((payload: unknown) => {
          if (table === 'ledger_entries') return ledgerInsert(payload);
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
        limit: jest.fn(() => query),
        single: jest.fn().mockImplementation(async () => ({
          data: table === 'payment_orders' ? order : tableData[table],
          error: null,
        })),
        maybeSingle: jest.fn().mockImplementation(async () => {
          if (table === 'payment_orders') {
            // Un UPDATE ... .select().maybeSingle() es el compare-and-set que
            // reclama el expediente; una lectura normal devuelve la fila.
            return { data: query.__isUpdate ? claimed : order, error: null };
          }
          return { data: tableData[table], error: null };
        }),
      };
      return query;
    });

    return { from, rpc, __updates: updates, __inserts: inserts, __ledgerInsert: ledgerInsert };
  }

  function makeService(supabase: any, opts: { bridgePost?: jest.Mock } = {}) {
    const bridgePost =
      opts.bridgePost ??
      jest.fn().mockResolvedValue({ id: 'bridge-transfer-uuid', state: 'awaiting_funds' });
    const sendNotification = jest.fn().mockResolvedValue(undefined);
    const emitOrderUpdated = jest.fn();
    const sendPaymentOrderFailedEmail = jest.fn().mockResolvedValue(true);

    const service = new PaymentOrdersService(
      supabase,
      { calculateFee: jest.fn(), getFeePercent: jest.fn(), assertFeeConfigured: jest.fn() } as any,
      {} as any, // psavService
      { getRate: jest.fn().mockResolvedValue({ effective_rate: 1 }) } as any,
      { post: bridgePost } as any,
      {} as any, // bankAccountsService
      {} as any, // orderReviewService
      { sendNotification } as any,
      { emitOrderCreated: jest.fn(), emitOrderUpdated } as any,
      { sendPaymentOrderFailedEmail, sendPaymentOrderCompletedEmail: jest.fn() } as any,
      {} as any, // pdfService
      // Switch por flujo de la puerta de revision: en los tests la puerta se
      // controla pasando `opts` a los creadores, asi que el servicio nunca la
      // consulta. requiresReview solo se usa desde createInterbankOrder /
      // createWalletRampOrder, que estos specs no ejercitan.
      { requiresReview: jest.fn().mockResolvedValue(true) } as any,
    ) as any;

    return { service, bridgePost, sendNotification, emitOrderUpdated, sendPaymentOrderFailedEmail };
  }

  // ── Qué flujos pasan por la puerta ──

  it('los 10 flujos que crea el cliente soportan la puerta', () => {
    for (const flow of [
      'bolivia_to_world',
      'bolivia_to_wallet',
      'world_to_bolivia',
      'wallet_to_wallet',
      'fiat_bo_to_bridge_wallet',
      'crypto_to_bridge_wallet',
      'bridge_wallet_to_fiat_bo',
      'bridge_wallet_to_crypto',
      'bridge_wallet_to_fiat_us',
      'wallet_to_world',
    ]) {
      expect(supportsStaffReviewGate(flow)).toBe(true);
    }
  });

  it('va_deposit queda fuera: no lo crea el cliente, lo dispara un webhook', () => {
    for (const flow of ['va_deposit', 'flujo_inventado', null, undefined]) {
      expect(supportsStaffReviewGate(flow as any)).toBe(false);
    }
  });

  it('soportar la puerta NO es lo mismo que tenerla activa', async () => {
    // supportsStaffReviewGate solo dice que existe un ejecutor para el flujo.
    // Que un expediente concreto deba esperar revisión lo decide el switch del
    // panel, vía FlowReviewSettingsService.requiresReview.
    const supabase = makeSupabase(pendingOrder());
    const { service } = makeService(supabase);

    service.flowReviewSettings.requiresReview = jest
      .fn()
      .mockResolvedValue(false);

    await expect(
      service.resolveReviewGate('bridge_wallet_to_fiat_bo'),
    ).resolves.toEqual({ skipReviewGate: true });

    service.flowReviewSettings.requiresReview = jest
      .fn()
      .mockResolvedValue(true);

    await expect(
      service.resolveReviewGate('bridge_wallet_to_fiat_bo'),
    ).resolves.toEqual({ skipReviewGate: false });
  });

  // ── Cableado: los dispatchers deben consultar el switch ──
  // Sin estos tests, un error de cableado aquí desactivaría la puerta en
  // silencio: los expedientes seguirían saliendo directos y nada fallaría.

  async function runDispatcher(
    kind: 'wallet-ramp' | 'interbank',
    requiresReview: boolean,
  ) {
    const supabase = makeSupabase(pendingOrder());
    const { service } = makeService(supabase);

    // Cortocircuitar todo lo previo al switch: límites, país, divisa, rate.
    service.validateRateLimit = jest.fn().mockResolvedValue(undefined);
    service.assertFlowEnabled = jest.fn().mockResolvedValue(undefined);
    service.assertCurrencyActive = jest.fn().mockResolvedValue(undefined);
    service.checkAmountLimits = jest
      .fn()
      .mockResolvedValue({ exceeded: false, amountUsd: 100, max: 1000 });
    service.flowReviewSettings.requiresReview = jest
      .fn()
      .mockResolvedValue(requiresReview);

    const creator = jest.fn().mockResolvedValue({
      id: ORDER_ID,
      user_id: 'user-1',
      status: requiresReview ? 'pending_review' : 'created',
      flow_type: 'x',
      amount: '100',
      currency: 'USDC',
    });

    if (kind === 'wallet-ramp') {
      service.createBridgeWalletToFiatBo = creator;
      await service.createWalletRampOrder('user-1', {
        flow_type: 'bridge_wallet_to_fiat_bo',
        amount: 100,
        source_currency: 'usdc',
      } as any);
    } else {
      service.createBoliviaToWorld = creator;
      await service.createInterbankOrder('user-1', {
        flow_type: 'bolivia_to_world',
        amount: 100,
        destination_currency: 'usd',
      } as any);
    }

    return creator;
  }

  it('createWalletRampOrder pasa al creador lo que diga el switch', async () => {
    const conReview = await runDispatcher('wallet-ramp', true);
    expect(conReview).toHaveBeenCalledWith(
      'user-1',
      expect.anything(),
      { skipReviewGate: false },
    );

    const sinReview = await runDispatcher('wallet-ramp', false);
    expect(sinReview).toHaveBeenCalledWith(
      'user-1',
      expect.anything(),
      { skipReviewGate: true },
    );
  });

  it('createInterbankOrder pasa al creador lo que diga el switch', async () => {
    const conReview = await runDispatcher('interbank', true);
    expect(conReview).toHaveBeenCalledWith(
      'user-1',
      expect.anything(),
      { skipReviewGate: false },
    );

    const sinReview = await runDispatcher('interbank', false);
    expect(sinReview).toHaveBeenCalledWith(
      'user-1',
      expect.anything(),
      { skipReviewGate: true },
    );
  });

  // ── Aprobación ──

  it('aprobar crea el transfer y deja el expediente en processing', async () => {
    const supabase = makeSupabase(pendingOrder());
    const { service, bridgePost, sendNotification, emitOrderUpdated } =
      makeService(supabase);

    await service.approveOrderReviewStep(ORDER_ID, 'staff-1', {
      notes: 'Documentación verificada',
    });

    expect(bridgePost).toHaveBeenCalledTimes(1);
    const [, , idempotencyKey] = bridgePost.mock.calls[0];
    expect(idempotencyKey).toBe(`po_w2fbo_${ORDER_ID}`);

    // El CAS reclama el expediente ANTES de llamar a Bridge.
    const claim = supabase.__updates['payment_orders'][0];
    expect(claim.status).toBe('processing');
    expect(claim.approved_by).toBe('staff-1');
    expect(claim.notes).toContain('[REVISIÓN] Documentación verificada');

    expect(supabase.__inserts['audit_logs'][0]).toMatchObject({
      action: 'APPROVE_ORDER_REVIEW',
      record_id: ORDER_ID,
    });
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Expediente aprobado' }),
    );
    expect(emitOrderUpdated).toHaveBeenCalled();
  });

  it('no se puede aprobar un expediente que no está en revisión', async () => {
    const supabase = makeSupabase(pendingOrder({ status: 'created' }));
    const { service, bridgePost } = makeService(supabase);

    await expect(
      service.approveOrderReviewStep(ORDER_ID, 'staff-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(bridgePost).not.toHaveBeenCalled();
  });

  it('si ya fue aprobado, el mensaje lo dice en vez de sonar a error genérico', async () => {
    const supabase = makeSupabase(pendingOrder({ status: 'processing' }));
    const { service, bridgePost } = makeService(supabase);

    await expect(
      service.approveOrderReviewStep(ORDER_ID, 'staff-2', {}),
    ).rejects.toThrow(/otro miembro del equipo/i);
    expect(bridgePost).not.toHaveBeenCalled();
  });

  it('doble aprobación simultánea: el segundo pierde el CAS y NO llega a Bridge', async () => {
    const supabase = makeSupabase(pendingOrder(), { claimed: null });
    const { service, bridgePost } = makeService(supabase);

    await expect(
      service.approveOrderReviewStep(ORDER_ID, 'staff-2', {}),
    ).rejects.toBeInstanceOf(ConflictException);

    // Lo importante: nunca se creó un segundo transfer en Bridge.
    expect(bridgePost).not.toHaveBeenCalled();
  });

  it('rechaza aprobar un flujo sin ejecutor (defensa en profundidad)', async () => {
    // va_deposit lo dispara un webhook de Bridge, no el cliente: aunque alguien
    // fabricase una fila en pending_review, no hay tramo que ejecutar.
    const supabase = makeSupabase(pendingOrder({ flow_type: 'va_deposit' }));
    const { service, bridgePost } = makeService(supabase);

    await expect(
      service.approveOrderReviewStep(ORDER_ID, 'staff-1', {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(bridgePost).not.toHaveBeenCalled();
  });

  it('rechaza aprobar un expediente sin contexto de ejecución guardado', async () => {
    const supabase = makeSupabase(
      pendingOrder({ bridge_execution_context: null }),
    );
    const { service, bridgePost } = makeService(supabase);

    await expect(
      service.approveOrderReviewStep(ORDER_ID, 'staff-1', {}),
    ).rejects.toThrow(/contexto de ejecución/i);
    expect(bridgePost).not.toHaveBeenCalled();
  });

  it('404 si el expediente no existe', async () => {
    const supabase = makeSupabase(null);
    const { service } = makeService(supabase);

    await expect(
      service.approveOrderReviewStep(ORDER_ID, 'staff-1', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── Fallo de Bridge al aprobar ──

  it('si Bridge falla al aprobar, vuelve a revisión sin liberar la reserva ni avisar de fallo', async () => {
    const supabase = makeSupabase(pendingOrder());
    const bridgePost = jest.fn().mockRejectedValue(new Error('502 Bad Gateway'));
    const { service, sendPaymentOrderFailedEmail } = makeService(supabase, {
      bridgePost,
    });

    await expect(
      service.approveOrderReviewStep(ORDER_ID, 'staff-1', {}),
    ).rejects.toThrow(/volvió a revisión/i);

    const rollback = supabase.__updates['payment_orders'].at(-1);
    expect(rollback.status).toBe('pending_review');
    expect(rollback.approved_by).toBeNull();

    // El expediente sigue vivo: ni se devuelve el saldo ni se avisa de un fallo
    // que en realidad es reintentable.
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'release_reserved_balance',
      expect.anything(),
    );
    expect(sendPaymentOrderFailedEmail).not.toHaveBeenCalled();
  });

  it('el reintento tras un fallo reutiliza la misma Idempotency-Key', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('timeout'));
    const first = makeSupabase(pendingOrder());
    const { service: s1 } = makeService(first, { bridgePost: failing });
    await expect(
      s1.approveOrderReviewStep(ORDER_ID, 'staff-1', {}),
    ).rejects.toThrow();

    const second = makeSupabase(pendingOrder());
    const { service: s2, bridgePost } = makeService(second);
    await s2.approveOrderReviewStep(ORDER_ID, 'staff-1', {});

    expect(failing.mock.calls[0][2]).toBe(bridgePost.mock.calls[0][2]);
    expect(bridgePost.mock.calls[0][2]).toBe(`po_w2fbo_${ORDER_ID}`);
  });

  // ── Rechazo ──

  it('rechazar cierra el expediente en failed y devuelve la reserva', async () => {
    const supabase = makeSupabase(pendingOrder());
    const { service, sendNotification, sendPaymentOrderFailedEmail } =
      makeService(supabase);

    await service.rejectOrderReviewStep(ORDER_ID, 'staff-1', {
      reason: 'El documento de respaldo no corresponde al motivo declarado',
    });

    const update = supabase.__updates['payment_orders'][0];
    expect(update.status).toBe('failed');
    expect(update.failure_reason).toContain(
      'El documento de respaldo no corresponde al motivo declarado',
    );

    // La reserva se devuelve desde el contexto de ejecución, NO escaneando
    // ledger_entries: un expediente en revisión no tiene ninguna fila de ledger.
    expect(supabase.rpc).toHaveBeenCalledWith('release_reserved_balance', {
      p_user_id: 'user-1',
      p_currency: 'USDC',
      p_amount: 1000,
    });
    expect(supabase.__ledgerInsert).not.toHaveBeenCalled();

    expect(supabase.__inserts['audit_logs'][0]).toMatchObject({
      action: 'REJECT_ORDER_REVIEW',
    });
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Expediente rechazado' }),
    );
    expect(sendPaymentOrderFailedEmail).toHaveBeenCalled();
  });

  it('rechazar respeta notify_user: false', async () => {
    const supabase = makeSupabase(pendingOrder());
    const { service, sendNotification } = makeService(supabase);

    await service.rejectOrderReviewStep(ORDER_ID, 'staff-1', {
      reason: 'Datos de destino incorrectos, se avisa por teléfono',
      notify_user: false,
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('wallet_to_world no libera nada al rechazar: nunca reservó saldo', async () => {
    const supabase = makeSupabase(
      pendingOrder({
        flow_type: 'wallet_to_world',
        bridge_execution_context: {
          kind: 'wallet_to_world',
          source_currency: 'USDC',
          amount: 1000,
          fee_amount: 30,
          net_amount: 970,
          total_needed: 0,
        },
      }),
    );
    const { service } = makeService(supabase);

    await service.rejectOrderReviewStep(ORDER_ID, 'staff-1', {
      reason: 'Motivo declarado insuficiente para el importe',
    });

    // release_reserved_balance suma al disponible sin comprobar nada: llamarlo
    // aquí regalaría saldo que el cliente nunca bloqueó.
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('no se puede rechazar un expediente que no está en revisión', async () => {
    const supabase = makeSupabase(pendingOrder({ status: 'processing' }));
    const { service } = makeService(supabase);

    await expect(
      service.rejectOrderReviewStep(ORDER_ID, 'staff-1', {
        reason: 'Motivo suficientemente largo',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── Cálculo de la reserva a devolver ──

  it('resolvePendingReviewReserve deriva importe y divisa del contexto', () => {
    expect(
      resolvePendingReviewReserve({
        currency: 'USD',
        source_currency: 'usdc',
        bridge_execution_context: FIAT_BO_CONTEXT,
      }),
    ).toEqual({ currency: 'USDC', amount: 1000 });

    // Sin contexto (expediente viejo) o sin reserva: no hay nada que devolver.
    expect(
      resolvePendingReviewReserve({ currency: 'USDC', bridge_execution_context: null }),
    ).toBeNull();
    expect(
      resolvePendingReviewReserve({
        currency: 'USDC',
        bridge_execution_context: { ...FIAT_BO_CONTEXT, total_needed: 0 },
      }),
    ).toBeNull();
  });
});

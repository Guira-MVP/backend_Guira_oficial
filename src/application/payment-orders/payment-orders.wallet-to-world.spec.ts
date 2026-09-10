import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentOrdersService } from './payment-orders.service';
import { WalletRampFlowType } from './dto/create-wallet-ramp-order.dto';

/**
 * Tests del flujo wallet_to_world.
 *
 * Las tres invariantes críticas de dinero, cada una con su test dedicado:
 *   1. NUNCA se llama reserve_balance  → los fondos no salen del saldo del cliente.
 *   2. NUNCA se inserta en ledger_entries → evita el cargo fantasma (ver el
 *      comentario extenso en createWalletToWorld).
 *   3. Sin tarifa activa se RECHAZA, en vez de crear la orden cobrando 0.
 *
 * Desde la puerta de revisión de staff el flujo tiene DOS fases:
 *   - createWalletToWorld deja el expediente en 'pending_review' SIN llamar a
 *     Bridge (por eso no hay QR todavía).
 *   - executeWalletToWorldLeg crea el transfer al aprobar y deja la orden en
 *     'waiting_deposit' con las instrucciones de depósito.
 * Pasando `{ skipReviewGate: true }` se recorre el camino sin puerta, que es el
 * que usa createOrderFromReview cuando el staff ya revisó en la otra cola.
 */
describe('PaymentOrdersService — wallet_to_world', () => {
  const BRIDGE_TRANSFER_RESPONSE = {
    id: 'bridge-transfer-uuid',
    state: 'awaiting_funds',
    source_deposit_instructions: {
      to_address: 'SoLaNaAddr111111111111111111111111111111111',
      payment_rail: 'solana',
      currency: 'usdc',
      amount: '1000.00',
    },
  };

  /** Contexto de ejecución tal y como lo persiste createWalletToWorld. */
  const EXEC_CONTEXT = {
    kind: 'wallet_to_world' as const,
    source_currency: 'USDC',
    amount: 1000,
    fee_amount: 30,
    net_amount: 970,
    total_needed: 0,
    source_network: 'solana',
    supplier_payment_rail: 'ach',
    external_account_local_id: 'ext-local-1',
    destination_currency: 'usd',
  };

  const PENDING_ORDER = {
    id: '8341dad5-6031-453f-ab01-f871b7e7fb31',
    user_id: 'user-1',
    wallet_id: null,
    flow_type: 'wallet_to_world',
    status: 'processing',
    bridge_execution_context: EXEC_CONTEXT,
  };

  /** Construye un mock de supabase que responde por tabla. */
  function makeSupabase(overrides: Record<string, unknown> = {}) {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
    const ledgerInsert = jest.fn().mockResolvedValue({ data: null, error: null });

    const tableData: Record<string, any> = {
      suppliers: {
        id: 'supplier-1',
        name: 'Proveedor SA',
        bridge_external_account_id: 'ext-local-1',
        bank_details: { bank_name: 'Chase', account_number: '123456789' },
        payment_rail: 'ach',
      },
      bridge_external_accounts: {
        id: 'ext-local-1',
        account_type: 'checking',
        currency: 'USD',
        bridge_external_account_id: 'ext-bridge-1',
      },
      profiles: { bridge_customer_id: 'cus_123' },
      wallets: { id: 'wallet-1', network: 'solana', provider_wallet_id: 'bw_1' },
      currency_settings: { currency: 'usdc', is_active: true },
      ...overrides,
    };

    const updates: Record<string, any[]> = {};

    const from = jest.fn((table: string) => {
      // Las respuestas se resuelven de forma perezosa (mockImplementation, no
      // mockResolvedValue) para poder devolver la fila realmente insertada.
      const query: any = {
        select: jest.fn(() => query),
        insert: jest.fn((payload: unknown) => {
          if (table === 'ledger_entries') return ledgerInsert(payload);
          query.__inserted = payload;
          return query;
        }),
        update: jest.fn((payload: unknown) => {
          (updates[table] ??= []).push(payload);
          return query;
        }),
        eq: jest.fn(() => query),
        in: jest.fn(() => query),
        or: jest.fn(() => query),
        limit: jest.fn(() => query),
        single: jest.fn().mockImplementation(async () => ({
          data:
            table === 'payment_orders'
              ? { id: 'order-1', ...(query.__inserted ?? {}) }
              : tableData[table],
          error: null,
        })),
        maybeSingle: jest.fn().mockImplementation(async () => ({
          // payment_orders vía maybeSingle = consulta de conflicto → sin colisión
          data: table === 'payment_orders' ? null : tableData[table],
          error: null,
        })),
      };
      return query;
    });

    return { from, rpc, __ledgerInsert: ledgerInsert, __updates: updates };
  }

  function makeService(supabase: any, opts: { bridgePost?: jest.Mock; assertFee?: jest.Mock } = {}) {
    const bridgePost = opts.bridgePost ?? jest.fn().mockResolvedValue(BRIDGE_TRANSFER_RESPONSE);
    const feesService = {
      calculateFee: jest.fn().mockResolvedValue({ fee_amount: 30, net_amount: 970 }),
      getFeePercent: jest.fn(),
      assertFeeConfigured: opts.assertFee ?? jest.fn().mockResolvedValue(undefined),
    };
    const service = new PaymentOrdersService(
      supabase,
      feesService as any,
      {} as any, // psavService
      { getRate: jest.fn().mockResolvedValue({ effective_rate: 1 }) } as any,
      { post: bridgePost } as any,
      {} as any, // bankAccountsService
      {} as any, // orderReviewService
      {} as any, // notificationsService
      { emitOrderCreated: jest.fn(), emitOrderUpdated: jest.fn() } as any,
      {} as any, // emailService
      {} as any, // pdfService
      // Switch por flujo de la puerta de revision: en los tests la puerta se
      // controla pasando `opts` a los creadores, asi que el servicio nunca la
      // consulta. requiresReview solo se usa desde createInterbankOrder /
      // createWalletRampOrder, que estos specs no ejercitan.
      { requiresReview: jest.fn().mockResolvedValue(true) } as any,
    ) as any;
    return { service, bridgePost, feesService };
  }

  const validDto = {
    flow_type: WalletRampFlowType.WALLET_TO_WORLD,
    amount: 1000,
    wallet_id: '11111111-1111-1111-1111-111111111111',
    source_network: 'solana',
    source_currency: 'usdc',
    supplier_id: 'supplier-1',
    business_purpose: 'Pago de factura 00123',
  } as any;

  /** Atajo para el camino sin puerta (expediente ya revisado por el staff). */
  const bypass = { skipReviewGate: true };

  // ── Puerta de revisión: la creación ya NO manda el dinero al proveedor ──

  it('con la puerta activa NO llama a Bridge: el expediente queda esperando revisión', async () => {
    const supabase = makeSupabase();
    const { service, bridgePost } = makeService(supabase);

    const order = await service.createWalletToWorld('user-1', validDto);

    expect(bridgePost).not.toHaveBeenCalled();
    expect(order.status).toBe('pending_review');
    expect(order.bridge_transfer_id).toBeNull();
    expect(order.bridge_source_deposit_instructions).toBeNull();
  });

  it('persiste el contexto de ejecución que el tramo Bridge necesitará al aprobar', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);

    const order = await service.createWalletToWorld('user-1', validDto);

    expect(order.bridge_execution_context).toMatchObject({
      kind: 'wallet_to_world',
      source_network: 'solana',
      source_currency: 'USDC',
      supplier_payment_rail: 'ach',
      external_account_local_id: 'ext-local-1',
      destination_currency: 'usd',
      // Este flujo nunca reserva saldo: no hay nada que devolver al rechazar.
      total_needed: 0,
    });
  });

  it('al aprobar crea el transfer y deja la orden en waiting_deposit con el QR', async () => {
    const supabase = makeSupabase();
    const { service, bridgePost } = makeService(supabase);

    const result = await service.executeWalletToWorldLeg(
      { ...PENDING_ORDER },
      EXEC_CONTEXT,
      { onFailure: 'return_to_review' },
    );

    expect(bridgePost).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('waiting_deposit');
    expect(result.bridge_transfer_id).toBe(BRIDGE_TRANSFER_RESPONSE.id);

    const persisted = supabase.__updates['payment_orders'].at(-1);
    expect(persisted.status).toBe('waiting_deposit');
    expect(persisted.bridge_source_deposit_instructions).toMatchObject({
      address: BRIDGE_TRANSFER_RESPONSE.source_deposit_instructions.to_address,
      amount: '1000.00',
      chain: 'solana',
    });
  });

  it('la Idempotency-Key deriva del id del expediente, así que sobrevive al salto crear→aprobar', async () => {
    const supabase = makeSupabase();
    const { service, bridgePost } = makeService(supabase);

    await service.executeWalletToWorldLeg({ ...PENDING_ORDER }, EXEC_CONTEXT, {
      onFailure: 'return_to_review',
    });

    const [, , idempotencyKey] = bridgePost.mock.calls[0];
    expect(idempotencyKey).toBe(`po_w2w_${PENDING_ORDER.id}`);
  });

  it('si Bridge falla al aprobar, el expediente vuelve a revisión y se puede reintentar', async () => {
    const supabase = makeSupabase();
    const bridgePost = jest.fn().mockRejectedValue(new Error('502 Bad Gateway'));
    const { service } = makeService(supabase, { bridgePost });

    await expect(
      service.executeWalletToWorldLeg({ ...PENDING_ORDER }, EXEC_CONTEXT, {
        onFailure: 'return_to_review',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const persisted = supabase.__updates['payment_orders'].at(-1);
    expect(persisted.status).toBe('pending_review');
    expect(persisted.approved_by).toBeNull();
    // La reserva no se toca: el expediente sigue vivo. (Aquí además es 0.)
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it('si al aprobar Bridge no devuelve dirección, el expediente se cierra en failed y NO vuelve a revisión', async () => {
    // La Idempotency-Key ya está quemada: un reintento recibiría eternamente el
    // mismo transfer sin dirección, así que reintentar sería un bucle infinito.
    const supabase = makeSupabase();
    const bridgePost = jest.fn().mockResolvedValue({ id: 'tid', state: 'awaiting_funds' });
    const { service } = makeService(supabase, { bridgePost });

    await expect(
      service.executeWalletToWorldLeg({ ...PENDING_ORDER }, EXEC_CONTEXT, {
        onFailure: 'return_to_review',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const persisted = supabase.__updates['payment_orders'].at(-1);
    expect(persisted.status).toBe('failed');
  });

  // ── Camino sin puerta (createOrderFromReview): comportamiento histórico ──

  it('envía a Bridge el payload correcto: allow_any_from_address, sin bridge_wallet_id ni flexible_amount', async () => {
    const supabase = makeSupabase();
    const { service, bridgePost } = makeService(supabase);

    await service.createWalletToWorld('user-1', validDto, bypass);

    expect(bridgePost).toHaveBeenCalledTimes(1);
    const [path, payload, idempotencyKey] = bridgePost.mock.calls[0];

    expect(path).toBe('/v0/transfers');
    expect(idempotencyKey).toMatch(/^po_w2w_/);

    // Origen on-chain, sin wallet custodiada ni dirección fija
    expect(payload.source).toEqual({ currency: 'usdc', payment_rail: 'solana' });
    expect(payload.source.bridge_wallet_id).toBeUndefined();
    expect(payload.source.from_address).toBeUndefined();

    // Monto fijo: developer_fee absoluto y SIN flexible_amount
    expect(payload.amount).toBe('1000.00');
    expect(payload.developer_fee).toBe('30.00');
    expect(payload.features).toEqual({ allow_any_from_address: true });
    expect(payload.features.flexible_amount).toBeUndefined();

    // Destino: cuenta del proveedor + referencia del riel
    expect(payload.destination.external_account_id).toBe('ext-bridge-1');
    expect(payload.destination.payment_rail).toBe('ach');
    expect(payload.destination.ach_reference).toBe('GUIRA');
  });

  it('un expediente que viene de una review ya aprobada NO pasa por pending_review', async () => {
    const supabase = makeSupabase();
    const { service, bridgePost } = makeService(supabase);

    const order = await service.createWalletToWorld('user-1', validDto, bypass);

    expect(bridgePost).toHaveBeenCalledTimes(1);
    expect(order.status).toBe('waiting_deposit');
    expect(order.bridge_execution_context).toBeNull();
    expect(order.bridge_source_deposit_instructions).toMatchObject({
      address: BRIDGE_TRANSFER_RESPONSE.source_deposit_instructions.to_address,
      amount: '1000.00',
      chain: 'solana',
    });
    expect(order.source_address).toBeNull();
  });

  it('funciona SIN wallet_id — no hay saldo del cliente de origen que elegir', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);
    const { wallet_id: _omitido, ...sinWallet } = validDto;

    const order = await service.createWalletToWorld('user-1', sinWallet);

    expect(order.status).toBe('pending_review');
    // El servicio resuelve una wallet activa por su cuenta, solo como referencia.
    expect(order.wallet_id).toBe('wallet-1');
  });

  it('rechaza si Bridge no devuelve dirección de depósito (un QR vacío es peor que un error)', async () => {
    const supabase = makeSupabase();
    const bridgePost = jest.fn().mockResolvedValue({ id: 'tid', state: 'awaiting_funds' });
    const { service } = makeService(supabase, { bridgePost });

    await expect(
      service.createWalletToWorld('user-1', validDto, bypass),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── Invariantes de dinero: valen en AMBOS caminos ──

  it('NUNCA reserva saldo — los fondos no salen del balance Guira', async () => {
    for (const opts of [undefined, bypass]) {
      const supabase = makeSupabase();
      const { service } = makeService(supabase);

      await service.createWalletToWorld('user-1', validDto, opts);

      expect(supabase.rpc).not.toHaveBeenCalledWith('reserve_balance', expect.anything());
      expect(supabase.rpc).not.toHaveBeenCalled();
    }
  });

  it('NUNCA escribe en ledger_entries — evita el cargo fantasma', async () => {
    for (const opts of [undefined, bypass]) {
      const supabase = makeSupabase();
      const { service } = makeService(supabase);

      await service.createWalletToWorld('user-1', validDto, opts);

      expect(supabase.__ledgerInsert).not.toHaveBeenCalled();
      expect(supabase.from).not.toHaveBeenCalledWith('ledger_entries');
    }
  });

  it('tampoco escribe en ledger_entries al aprobar la revisión', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);

    await service.executeWalletToWorldLeg({ ...PENDING_ORDER }, EXEC_CONTEXT, {
      onFailure: 'return_to_review',
    });

    expect(supabase.__ledgerInsert).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  // ── Validaciones de entrada: rechazan antes de crear nada ──

  it('rechaza si no hay tarifa activa, en vez de crear la orden cobrando 0', async () => {
    const supabase = makeSupabase();
    const assertFee = jest
      .fn()
      .mockRejectedValue(new BadRequestException('El destino ACH (USD) no está habilitado en este momento.'));
    const { service, bridgePost } = makeService(supabase, { assertFee });

    await expect(service.createWalletToWorld('user-1', validDto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // No debe haberse llamado a Bridge ni creado nada
    expect(bridgePost).not.toHaveBeenCalled();
  });

  it('rechaza combinaciones red/token fuera del catálogo', async () => {
    const supabase = makeSupabase();
    const { service, bridgePost } = makeService(supabase);

    await expect(
      service.createWalletToWorld('user-1', { ...validDto, source_network: 'tron', source_currency: 'usdt' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(bridgePost).not.toHaveBeenCalled();
  });

  it('bloquea un segundo envío activo al mismo proveedor con el mismo token', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);
    jest
      .spyOn(service, 'assertNoConflictingWalletToWorld')
      .mockRejectedValue(new ConflictException('ya existe'));

    await expect(service.createWalletToWorld('user-1', validDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('exige supplier_id y business_purpose', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);

    await expect(
      service.createWalletToWorld('user-1', { ...validDto, supplier_id: undefined }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createWalletToWorld('user-1', { ...validDto, business_purpose: undefined }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

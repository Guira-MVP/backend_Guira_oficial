import { PaymentOrdersService } from './payment-orders.service';
import { InterbankFlowType } from './dto/create-interbank-order.dto';

/**
 * Tests de la puerta de revisión en los flujos donde el cliente DEPOSITA.
 *
 * La invariante que se protege es una sola, y es la razón de ser de la puerta en
 * estos flujos: mientras el expediente está en revisión, el cliente NO puede
 * tener instrucciones de pago. Si pudiera depositar y luego el staff rechazara,
 * habría que devolver dinero que ya entró — exactamente lo que la puerta evita.
 */
describe('PaymentOrdersService — puerta de revisión en flujos de depósito', () => {
  const PSAV_ACCOUNT = {
    id: 'psav-bo-1',
    type: 'bank_bo',
    currency: 'BOB',
    bank_name: 'Banco Unión',
    account_number: '1234567890',
    account_holder: 'Guira SRL',
  };

  const PSAV_INSTRUCTIONS = {
    type: 'bank',
    bank_name: 'Banco Unión',
    account_number: '1234567890',
    account_holder: 'Guira SRL',
    label: 'Depósito en BOB',
  };

  function makeSupabase() {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
    const updates: Record<string, any[]> = {};

    const tableData: Record<string, any> = {
      profiles: { bridge_customer_id: 'cus_123' },
      bridge_external_accounts: {
        id: 'ext-local-1',
        bank_name: 'Chase',
        account_name: 'Proveedor SA',
        currency: 'USD',
        bridge_external_account_id: 'ext-bridge-1',
        account_last_4: '6789',
      },
      suppliers: {
        id: 'supplier-1',
        name: 'Proveedor SA',
        bridge_liquidation_address_id: null,
        bank_details: {
          bank_name: 'Chase',
          account_number: '123456789',
          // Destino cripto que usa wallet_to_wallet.
          wallet_address: 'SoLaNaProveedor1111111111111111111111111',
          wallet_network: 'solana',
          wallet_currency: 'usdc',
        },
        payment_rail: 'ach',
      },
      currency_settings: { currency: 'usdc', is_active: true },
      client_bank_accounts: {
        id: 'cba-1',
        bank_name: 'BNB',
        account_number: '999',
        account_holder: 'Cliente',
      },
    };

    const from = jest.fn((table: string) => {
      const query: any = {
        select: jest.fn(() => query),
        insert: jest.fn((payload: unknown) => {
          query.__inserted = payload;
          return query;
        }),
        update: jest.fn((payload: unknown) => {
          (updates[table] ??= []).push(payload);
          return query;
        }),
        eq: jest.fn(() => query),
        in: jest.fn(() => query),
        not: jest.fn(() => query),
        ilike: jest.fn(() => query),
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
          data: table === 'payment_orders' ? null : tableData[table],
          error: null,
        })),
      };
      return query;
    });

    return { from, rpc, __updates: updates };
  }

  function makeService(supabase: any) {
    const getDepositAccountForUser = jest.fn().mockResolvedValue(PSAV_ACCOUNT);
    const formatDepositInstructions = jest.fn().mockReturnValue(PSAV_INSTRUCTIONS);
    const bridgePost = jest.fn().mockResolvedValue({
      id: 'bridge-transfer-uuid',
      state: 'awaiting_funds',
    });

    const service = new PaymentOrdersService(
      supabase,
      {
        calculateFee: jest
          .fn()
          .mockResolvedValue({ fee_amount: 30, net_amount: 970 }),
        getFeePercent: jest.fn().mockResolvedValue('1.0'),
        assertFeeConfigured: jest.fn(),
        getFeeConfigRow: jest.fn().mockResolvedValue({
          fee_type: 'percent',
          fee_percent: 1,
          fee_fixed: 0,
        }),
      } as any,
      { getDepositAccountForUser, formatDepositInstructions } as any,
      { getRate: jest.fn().mockResolvedValue({ effective_rate: 6.96 }) } as any,
      { post: bridgePost } as any,
      {
        getApprovedAccountForWithdrawal: jest.fn().mockResolvedValue({
          id: 'cba-1',
          bank_name: 'BNB',
          account_number: '999',
          account_holder: 'Cliente',
        }),
      } as any,
      {} as any, // orderReviewService
      {} as any, // notificationsService
      { emitOrderCreated: jest.fn(), emitOrderUpdated: jest.fn() } as any,
      {} as any, // emailService
      {} as any, // pdfService
      { requiresReview: jest.fn().mockResolvedValue(true) } as any,
    ) as any;

    return { service, getDepositAccountForUser, formatDepositInstructions, bridgePost };
  }

  const worldToBoliviaDto = {
    flow_type: InterbankFlowType.WORLD_TO_BOLIVIA,
    amount: 1000,
    source_currency: 'usd',
    business_purpose: 'Pago de factura 00123',
  } as any;

  it('world_to_bolivia en revisión NO expone la cuenta donde depositar', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);

    const order = await service.createWorldToBolivia('user-1', worldToBoliviaDto);

    expect(order.status).toBe('pending_review');
    expect(order.psav_deposit_instructions).toBeNull();
    expect(order.bridge_execution_context).toMatchObject({
      kind: 'psav_deposit',
      psav_type: 'bank_us',
      psav_currency: 'USD',
      // Ningún flujo de entrada reserva saldo: no hay nada que devolver.
      total_needed: 0,
    });
  });

  it('sin puerta, world_to_bolivia sigue publicando la cuenta al crear', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);

    const order = await service.createWorldToBolivia('user-1', worldToBoliviaDto, {
      skipReviewGate: true,
    });

    expect(order.status).toBe('waiting_deposit');
    expect(order.psav_deposit_instructions).toEqual(PSAV_INSTRUCTIONS);
  });

  it('al aprobar se publica la cuenta y el expediente pasa a esperar el depósito', async () => {
    const supabase = makeSupabase();
    const { service, getDepositAccountForUser } = makeService(supabase);

    const result = await service.executeReviewedBridgeLeg(
      {
        id: 'order-1',
        user_id: 'user-1',
        flow_type: 'world_to_bolivia',
        status: 'processing',
        bridge_execution_context: {
          kind: 'psav_deposit',
          source_currency: 'USD',
          amount: 1000,
          fee_amount: 30,
          net_amount: 970,
          total_needed: 0,
          psav_type: 'bank_us',
          psav_currency: 'USD',
        },
      },
      { onFailure: 'return_to_review' },
    );

    expect(result.status).toBe('waiting_deposit');
    // El canal se resuelve AL APROBAR, no al crear: el operador pudo cambiar de
    // cuenta receptora mientras el expediente esperaba.
    expect(getDepositAccountForUser).toHaveBeenCalledWith('user-1', 'bank_us', 'USD');

    const persisted = supabase.__updates['payment_orders'].at(-1);
    expect(persisted.status).toBe('waiting_deposit');
    expect(persisted.psav_deposit_instructions).toEqual(PSAV_INSTRUCTIONS);
  });

  it('si el canal PSAV ya no existe, la aprobación falla y el expediente vuelve a revisión', async () => {
    const supabase = makeSupabase();
    const { service } = makeService(supabase);
    service.psavService.getDepositAccountForUser = jest
      .fn()
      .mockRejectedValue(new Error('No hay cuenta PSAV activa para bank_us/USD'));

    await expect(
      service.executeReviewedBridgeLeg(
        {
          id: 'order-1',
          user_id: 'user-1',
          status: 'processing',
          bridge_execution_context: {
            kind: 'psav_deposit',
            source_currency: 'USD',
            amount: 1000,
            fee_amount: 30,
            net_amount: 970,
            total_needed: 0,
            psav_type: 'bank_us',
            psav_currency: 'USD',
          },
        },
        { onFailure: 'return_to_review' },
      ),
    ).rejects.toThrow(/volvió a revisión/i);

    const persisted = supabase.__updates['payment_orders'].at(-1);
    expect(persisted.status).toBe('pending_review');
  });

  it('wallet_to_wallet en revisión no crea el transfer: sin transfer no hay dirección de pago', async () => {
    const supabase = makeSupabase();
    const { service, bridgePost } = makeService(supabase);

    const order = await service.createWalletToWallet('user-1', {
      flow_type: InterbankFlowType.WALLET_TO_WALLET,
      amount: 1000,
      supplier_id: 'supplier-1',
      source_network: 'solana',
      source_currency: 'usdc',
      destination_currency: 'usdc',
      business_purpose: 'Pago de factura 00123',
    } as any);

    expect(bridgePost).not.toHaveBeenCalled();
    expect(order.status).toBe('pending_review');
    expect(order.bridge_execution_context).toMatchObject({
      kind: 'wallet_to_wallet',
      destination_address: 'SoLaNaProveedor1111111111111111111111111',
    });
  });
});

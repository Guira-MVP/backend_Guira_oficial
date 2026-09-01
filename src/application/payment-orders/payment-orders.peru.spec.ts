import { PaymentOrdersService } from './payment-orders.service';
import { WalletRampFlowType } from './dto/create-wallet-ramp-order.dto';

/**
 * Tests del pago a Perú (bridge_wallet_to_fiat_us + destination_type manual_pe_bank).
 *
 * Es un flujo de DOS TRAMOS calcado de bridge_wallet_to_fiat_bo: Bridge mueve los
 * fondos a la wallet crypto del PSAV y el PSAV los envía a Pythas, que paga al
 * proveedor peruano. Las invariantes que se protegen aquí:
 *
 *   1. El transfer va a la dirección del PSAV, NO a una external account de Bridge
 *      (los proveedores peruanos no tienen cuenta registrada en Bridge).
 *   2. La orden queda marcada como dual-leg (requires_psav + manual_pe_bank) para
 *      que el webhook no la cierre al llegar el dinero al PSAV.
 *   3. No hay conversión de divisa: el proveedor cobra en USD por SWIFT.
 *   4. La comisión se indexa por el riel peruano en USD, no por la moneda del
 *      proveedor (que está registrado en PEN).
 *   5. Los proveedores NO peruanos siguen liquidando contra su external account.
 */
describe('PaymentOrdersService — pago a Perú (PSAV + Pythas)', () => {
  const PSAV_ADDRESS = '4KSoLZYNSnUJU189YfUGHvP9A9rKXdjL2qPVrvDdthTL';
  const BRIDGE_TRANSFER_RESPONSE = { id: 'bridge-transfer-uuid', state: 'awaiting_funds' };

  const PERU_SUPPLIER = {
    id: 'supplier-pe',
    name: 'Proveedor Peruano SAC',
    // Sin external account: es justo lo que distingue a este proveedor.
    bridge_external_account_id: null,
    payment_rail: 'pe_bank_transfer',
    bank_details: {
      bank_name: 'BCP',
      account_number: '10060025',
      cci: '00219100123456789012',
      swift_bic: 'BCPLPEPL',
      provider: 'pythas',
    },
  };

  const ACH_SUPPLIER = {
    id: 'supplier-us',
    name: 'Proveedor SA',
    bridge_external_account_id: 'ext-local-1',
    payment_rail: 'ach',
    bank_details: { bank_name: 'Chase', account_number: '123456789' },
  };

  function makeSupabase(supplier: unknown) {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
    const ledgerInsert = jest.fn().mockResolvedValue({ data: null, error: null });

    const tableData: Record<string, any> = {
      suppliers: supplier,
      bridge_external_accounts: {
        id: 'ext-local-1',
        account_type: 'checking',
        currency: 'USD',
        bridge_external_account_id: 'ext-bridge-1',
      },
      profiles: { bridge_customer_id: 'cus_123' },
      wallets: { id: 'wallet-1', network: 'solana', provider_wallet_id: 'bw_1' },
      balances: { available_amount: '5000' },
      va_source_currency_settings: { is_active_supplier: true },
    };

    const from = jest.fn((table: string) => {
      const query: any = {
        select: jest.fn(() => query),
        insert: jest.fn((payload: unknown) => {
          if (table === 'ledger_entries') return ledgerInsert(payload);
          query.__inserted = payload;
          return query;
        }),
        update: jest.fn(() => query),
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

    return { from, rpc, __ledgerInsert: ledgerInsert };
  }

  function makeService(supabase: any) {
    const bridgePost = jest.fn().mockResolvedValue(BRIDGE_TRANSFER_RESPONSE);
    const calculateFee = jest
      .fn()
      .mockResolvedValue({ fee_amount: 30, net_amount: 970 });
    const psavService = {
      getActiveCryptoAccountsForUser: jest.fn().mockResolvedValue([
        {
          currency: 'USDC',
          crypto_network: 'solana',
          crypto_address: PSAV_ADDRESS,
        },
      ]),
    };
    const getRate = jest.fn().mockResolvedValue({ effective_rate: 1 });

    const service = new PaymentOrdersService(
      supabase,
      { calculateFee, getFeePercent: jest.fn(), assertFeeConfigured: jest.fn() } as any,
      psavService as any,
      { getRate } as any,
      { post: bridgePost } as any,
      {} as any, // bankAccountsService
      {} as any, // orderReviewService
      {} as any, // notificationsService
      { emitOrderCreated: jest.fn(), emitOrderUpdated: jest.fn() } as any,
      {} as any, // emailService
      {} as any, // pdfService
    ) as any;

    return { service, bridgePost, calculateFee, psavService, getRate };
  }

  const dto = {
    flow_type: WalletRampFlowType.BRIDGE_WALLET_TO_FIAT_US,
    amount: 1000,
    wallet_id: '11111111-1111-1111-1111-111111111111',
    source_currency: 'usdc',
    supplier_id: 'supplier-pe',
    business_purpose: 'Pago de factura 00123',
  } as any;

  it('transfiere a la wallet del PSAV, no a una external account de Bridge', async () => {
    const supabase = makeSupabase(PERU_SUPPLIER);
    const { service, bridgePost } = makeService(supabase);

    await service.createBridgeWalletToFiatUs('user-1', dto);

    expect(bridgePost).toHaveBeenCalledTimes(1);
    const [path, payload, idempotencyKey] = bridgePost.mock.calls[0];

    expect(path).toBe('/v0/transfers');
    expect(idempotencyKey).toMatch(/^po_pe_/);
    expect(payload.destination).toEqual({
      payment_rail: 'solana',
      currency: 'usdc',
      to_address: PSAV_ADDRESS,
    });
    // El destino jamás debe ser una cuenta bancaria registrada en Bridge
    expect(payload.destination.external_account_id).toBeUndefined();
    // Origen: la wallet custodiada del cliente, con la comisión como developer_fee
    expect(payload.source.bridge_wallet_id).toBe('bw_1');
    expect(payload.developer_fee).toBe('30.00');
  });

  it('marca la orden como dual-leg y sin conversión de divisa', async () => {
    const supabase = makeSupabase(PERU_SUPPLIER);
    const { service } = makeService(supabase);

    const order = await service.createBridgeWalletToFiatUs('user-1', dto);

    expect(order.destination_type).toBe('manual_pe_bank');
    expect(order.requires_psav).toBe(true);
    expect(order.flow_type).toBe('bridge_wallet_to_fiat_us');
    // El proveedor cobra en dólares vía SWIFT: sin conversión ni tasa aplicada
    expect(order.destination_currency).toBe('USD');
    expect(order.exchange_rate_applied).toBe(1.0);
    expect(order.amount_destination).toBe(970);
    // Snapshot del proveedor peruano para trazabilidad
    expect(order.destination_bank_name).toBe('BCP');
    expect(order.destination_account_number).toBe('****0025');
    expect(order.supplier_id).toBe('supplier-pe');
  });

  it('no consulta el tipo de cambio: la tasa es 1 por definición', async () => {
    const supabase = makeSupabase(PERU_SUPPLIER);
    const { service, getRate } = makeService(supabase);

    await service.createBridgeWalletToFiatUs('user-1', dto);

    expect(getRate).not.toHaveBeenCalled();
  });

  it('cobra la comisión del riel peruano en USD, no en la moneda del proveedor', async () => {
    const supabase = makeSupabase(PERU_SUPPLIER);
    const { service, calculateFee } = makeService(supabase);

    await service.createBridgeWalletToFiatUs('user-1', dto);

    expect(calculateFee).toHaveBeenCalledWith(
      'user-1',
      'ramp_off_fiat_us',
      'pe_bank_transfer',
      'USD',
      1000,
    );
  });

  it('reserva el saldo y asienta el débito pendiente en el ledger', async () => {
    const supabase = makeSupabase(PERU_SUPPLIER);
    const { service } = makeService(supabase);

    await service.createBridgeWalletToFiatUs('user-1', dto);

    expect(supabase.rpc).toHaveBeenCalledWith('reserve_balance', {
      p_user_id: 'user-1',
      p_currency: 'USDC',
      p_amount: 1000,
    });
    expect(supabase.rpc).not.toHaveBeenCalledWith(
      'release_reserved_balance',
      expect.anything(),
    );
    expect(supabase.__ledgerInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'debit',
        status: 'pending',
        amount: 1000,
        reference_type: 'payment_order',
      }),
    );
  });

  it('no regresión: un proveedor ACH sigue liquidando contra su external account de Bridge', async () => {
    const supabase = makeSupabase(ACH_SUPPLIER);
    const { service, bridgePost, psavService } = makeService(supabase);

    await service.createBridgeWalletToFiatUs('user-1', {
      ...dto,
      supplier_id: 'supplier-us',
    });

    const [, payload, idempotencyKey] = bridgePost.mock.calls[0];
    expect(idempotencyKey).toMatch(/^po_w2f_/);
    expect(payload.destination.external_account_id).toBe('ext-bridge-1');
    expect(payload.destination.to_address).toBeUndefined();
    // La ruta Bridge no toca al PSAV
    expect(psavService.getActiveCryptoAccountsForUser).not.toHaveBeenCalled();
  });
});

import { BadRequestException, ConflictException } from '@nestjs/common';
import { PaymentOrdersService } from './payment-orders.service';
import { InterbankFlowType } from './dto/create-interbank-order.dto';

describe('PaymentOrdersService bridge deposit collision guard', () => {
  const createService = (supabase: any = {}) =>
    new PaymentOrdersService(
      supabase,
      { calculateFee: jest.fn(), getFeePercent: jest.fn() } as any,
      {} as any,
      {} as any,
      { post: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // ordersGateway
      {} as any, // emailService
      {} as any, // pdfService
      // Switch por flujo de la puerta de revision: en los tests la puerta se
      // controla pasando `opts` a los creadores, asi que el servicio nunca la
      // consulta. requiresReview solo se usa desde createInterbankOrder /
      // createWalletRampOrder, que estos specs no ejercitan.
      { requiresReview: jest.fn().mockResolvedValue(true) } as any,
    );

  // El guard trae candidatos y decide en memoria cuál ocupa la dirección de
  // depósito, así que la consulta resuelve una LISTA (no .maybeSingle()).
  const createCollisionQuery = (candidates: unknown[]) => {
    const query: any = {
      select: jest.fn(() => query),
      eq: jest.fn(() => query),
      in: jest.fn(() => query),
      or: jest.fn(() => query),
      not: jest.fn(() => query),
      limit: jest.fn().mockResolvedValue({ data: candidates, error: null }),
    };
    return query;
  };

  it('checks wallet_to_wallet when looking for conflicting Bridge deposit orders', async () => {
    const query = createCollisionQuery([
      {
        id: '12345678-aaaa-bbbb-cccc-123456789012',
        flow_type: 'wallet_to_wallet',
        status: 'waiting_deposit',
        bridge_transfer_id: 'bridge-transfer-uuid',
        created_at: '2026-05-12T00:00:00.000Z',
      },
    ]);
    const service = createService({ from: jest.fn(() => query) }) as any;

    await expect(
      service.assertNoConflictingBridgeDepositOrder(
        'user-1',
        'usdc',
        'ethereum',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(query.in).toHaveBeenCalledWith('flow_type', [
      'fiat_bo_to_bridge_wallet',
      'crypto_to_bridge_wallet',
      'wallet_to_wallet',
    ]);
    expect(query.eq).toHaveBeenCalledWith('source_network', 'ethereum');
    expect(query.or).toHaveBeenCalledWith(
      'source_currency.eq.USDC,source_currency.is.null',
    );
    expect(query.in).toHaveBeenCalledWith('status', [
      'pending_review',
      'waiting_deposit',
    ]);
  });

  it('bloquea también contra un expediente en revisión, que aún no tiene transfer', async () => {
    // Sin esto un cliente podría acumular varios expedientes en revisión sobre
    // la misma ruta y el staff, al aprobarlos, generaría varios transfers que
    // Bridge resolvería contra la MISMA dirección de depósito.
    const query = createCollisionQuery([
      {
        id: '12345678-aaaa-bbbb-cccc-123456789012',
        flow_type: 'crypto_to_bridge_wallet',
        status: 'pending_review',
        bridge_transfer_id: null,
        created_at: '2026-05-12T00:00:00.000Z',
      },
    ]);
    const service = createService({ from: jest.fn(() => query) }) as any;

    await expect(
      service.assertNoConflictingBridgeDepositOrder('user-1', 'usdc', 'solana'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('un waiting_deposit sin transfer NO bloquea: no ocupa ninguna dirección', async () => {
    const query = createCollisionQuery([
      {
        id: '12345678-aaaa-bbbb-cccc-123456789012',
        flow_type: 'wallet_to_wallet',
        status: 'waiting_deposit',
        bridge_transfer_id: null,
        created_at: '2026-05-12T00:00:00.000Z',
      },
    ]);
    const service = createService({ from: jest.fn(() => query) }) as any;

    await expect(
      service.assertNoConflictingBridgeDepositOrder('user-1', 'usdc', 'solana'),
    ).resolves.toBeUndefined();
  });

  it('allows Bridge deposit orders when there is no same network/currency conflict', async () => {
    const query = createCollisionQuery([]);
    const service = createService({ from: jest.fn(() => query) }) as any;

    await expect(
      service.assertNoConflictingBridgeDepositOrder('user-1', 'usdt', 'tron'),
    ).resolves.toBeUndefined();
  });

  it('runs the collision guard for wallet_to_wallet before fees or inserts', async () => {
    const supplierQuery: any = {
      select: jest.fn(() => supplierQuery),
      eq: jest.fn(() => supplierQuery),
      single: jest.fn().mockResolvedValue({
        data: {
          id: 'supplier-1',
          name: 'Proveedor',
          payment_rail: 'crypto',
          bank_details: {
            wallet_address: '0xabc',
            wallet_network: 'ethereum',
            wallet_currency: 'usdc',
          },
        },
        error: null,
      }),
    };

    // assertCurrencyActive() queries 'currency_settings' using .single()
    // — mock it separately so the currency check passes before reaching the guard.
    const currencyQuery: any = {
      select: jest.fn(() => currencyQuery),
      eq: jest.fn(() => currencyQuery),
      single: jest.fn().mockResolvedValue({
        data: { currency: 'usdc', is_active: true },
        error: null,
      }),
    };

    const supabase = {
      from: jest.fn((table: string) =>
        table === 'currency_settings' ? currencyQuery : supplierQuery,
      ),
    };
    const feesService = {
      calculateFee: jest.fn(),
      getFeePercent: jest.fn(),
    };
    const service = new PaymentOrdersService(
      supabase as any,
      feesService as any,
      {} as any,
      {} as any,
      { post: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any, // ordersGateway
      {} as any, // emailService
      {} as any, // pdfService
      // Switch por flujo de la puerta de revision: en los tests la puerta se
      // controla pasando `opts` a los creadores, asi que el servicio nunca la
      // consulta. requiresReview solo se usa desde createInterbankOrder /
      // createWalletRampOrder, que estos specs no ejercitan.
      { requiresReview: jest.fn().mockResolvedValue(true) } as any,
    ) as any;
    const guard = jest
      .spyOn(service, 'assertNoConflictingBridgeDepositOrder')
      .mockRejectedValue(new BadRequestException('conflict'));

    await expect(
      service.createWalletToWallet('user-1', {
        flow_type: InterbankFlowType.WALLET_TO_WALLET,
        amount: 2,
        source_network: 'solana',
        source_currency: 'usdc',
        supplier_id: 'supplier-1',
        business_purpose: 'Pago proveedor',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(guard).toHaveBeenCalledWith('user-1', 'usdc', 'solana');
    expect(feesService.getFeePercent).not.toHaveBeenCalled();
    expect(feesService.calculateFee).not.toHaveBeenCalled();
  });
});

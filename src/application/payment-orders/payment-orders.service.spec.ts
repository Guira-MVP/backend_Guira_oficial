import { BadRequestException } from '@nestjs/common';
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
    );

  const createCollisionQuery = (conflicting: unknown) => {
    const query: any = {
      select: jest.fn(() => query),
      eq: jest.fn(() => query),
      in: jest.fn(() => query),
      or: jest.fn(() => query),
      not: jest.fn(() => query),
      limit: jest.fn(() => query),
      maybeSingle: jest.fn().mockResolvedValue({ data: conflicting }),
    };
    return query;
  };

  it('checks wallet_to_wallet when looking for conflicting Bridge deposit orders', async () => {
    const query = createCollisionQuery({
      id: '12345678-aaaa-bbbb-cccc-123456789012',
      flow_type: 'wallet_to_wallet',
      created_at: '2026-05-12T00:00:00.000Z',
    });
    const service = createService({ from: jest.fn(() => query) }) as any;

    await expect(
      service.assertNoConflictingBridgeDepositOrder(
        'user-1',
        'usdc',
        'ethereum',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(query.in).toHaveBeenCalledWith('flow_type', [
      'fiat_bo_to_bridge_wallet',
      'crypto_to_bridge_wallet',
      'wallet_to_wallet',
    ]);
    expect(query.eq).toHaveBeenCalledWith('source_network', 'ethereum');
    expect(query.or).toHaveBeenCalledWith(
      'source_currency.eq.USDC,source_currency.is.null',
    );
  });

  it('allows Bridge deposit orders when there is no same network/currency conflict', async () => {
    const query = createCollisionQuery(null);
    const service = createService({ from: jest.fn(() => query) }) as any;

    await expect(
      service.assertNoConflictingBridgeDepositOrder(
        'user-1',
        'usdt',
        'tron',
      ),
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
    const supabase = { from: jest.fn(() => supplierQuery) };
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

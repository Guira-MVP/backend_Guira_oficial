import { WebhooksService } from './webhooks.service';

/**
 * transfer.complete / payment_processed de un bridge_wallet_to_fiat_us con
 * Fixed Outputs. El destino está garantizado, así que la tasa cotizada NO se
 * sobrescribe con receipt.exchange_rate (que incluye la comisión); se guarda
 * aparte junto con la ganancia cambiaria (developer_exchange_fee).
 */
describe('WebhooksService — transfer complete con Fixed Outputs', () => {
  function makeService(order: any) {
    const updates: Record<string, any[]> = {};
    const from = jest.fn((table: string) => {
      const query: any = {
        select: jest.fn(() => query),
        update: jest.fn((payload: unknown) => {
          (updates[table] ??= []).push(payload);
          return query;
        }),
        insert: jest.fn(() => query),
        eq: jest.fn(() => query),
        in: jest.fn(() => query),
        limit: jest.fn(() => query),
        maybeSingle: jest.fn(async () => ({
          data: table === 'payment_orders' ? order : null,
          error: null,
        })),
        single: jest.fn(async () => ({ data: null, error: null })),
        then: (resolve: any) => resolve({ data: [], error: null }),
      };
      return query;
    });

    const svc = Object.create(WebhooksService.prototype) as any;
    svc.supabase = {
      from,
      rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    svc.ordersGateway = { emitOrderUpdated: jest.fn() };
    svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    svc.notifyOrderFinalStatusEmail = jest.fn().mockResolvedValue(undefined);
    svc.notifyAdminStaff = jest.fn().mockResolvedValue(undefined);
    return { svc, updates };
  }

  const baseOrder = {
    id: 'order-1',
    user_id: 'user-1',
    wallet_id: 'wallet-1',
    flow_type: 'bridge_wallet_to_fiat_us',
    destination_type: 'external_account',
    amount: '1139.36',
    fee_amount: '34.18',
    amount_destination: '1000',
    currency: 'USDC',
    source_currency: 'USDC',
    destination_currency: 'EUR',
  };

  const payload = (finalAmount: string) => ({
    event_object: {
      id: 'tr_1',
      state: 'payment_processed',
      receipt: {
        initial_amount: '1139.36',
        final_amount: finalAmount,
        exchange_rate: '0.877686',
        developer_exchange_fee: { amount: '9.87', currency: 'eur' },
      },
    },
  });

  it('conserva la tasa cotizada y guarda la tasa del recibo y la ganancia cambiaria', async () => {
    const { svc, updates } = makeService({
      ...baseOrder,
      fx_mode: 'fixed_output',
    });

    await svc.handleTransferComplete(payload('1000.00'), 'payment_processed');

    const orderUpdate = updates.payment_orders.find(
      (u: any) => u.status === 'completed',
    );
    expect(orderUpdate).toBeDefined();
    expect(orderUpdate).not.toHaveProperty('exchange_rate_applied');
    expect(orderUpdate).toMatchObject({
      receipt_exchange_rate: 0.877686,
      developer_exchange_fee_amount: 9.87,
      developer_exchange_fee_currency: 'EUR',
      amount_destination: 1000,
    });
    expect(svc.notifyAdminStaff).not.toHaveBeenCalled();
  });

  it('avisa al staff si Bridge entregó un monto distinto al garantizado', async () => {
    const { svc } = makeService({ ...baseOrder, fx_mode: 'fixed_output' });

    await svc.handleTransferComplete(payload('998.50'), 'payment_processed');

    expect(svc.notifyAdminStaff).toHaveBeenCalledWith(
      'Monto de destino distinto al garantizado',
      expect.stringContaining('998.5'),
      'order-1',
    );
  });

  it('sin Fixed Outputs sigue sobrescribiendo con la tasa real de Bridge', async () => {
    const { svc, updates } = makeService({ ...baseOrder, fx_mode: null });

    await svc.handleTransferComplete(payload('1000.00'), 'payment_processed');

    const orderUpdate = updates.payment_orders.find(
      (u: any) => u.status === 'completed',
    );
    expect(orderUpdate.exchange_rate_applied).toBe(0.877686);
    expect(orderUpdate).not.toHaveProperty('receipt_exchange_rate');
  });
});

import { WebhooksService } from './webhooks.service';

/**
 * transfer.updated → 'underfunded' (Fixed Outputs de bolivia_to_world).
 *
 * Bridge retiene el Transfer porque el USDC recibido ya no alcanza para el
 * destination.amount. Se verifica que la orden conserve su estado, guarde las
 * additional_funding_instructions y avise al staff.
 */
describe('WebhooksService — transfer underfunded', () => {
  const ORDER = {
    id: 'order-1',
    user_id: 'user-1',
    flow_type: 'bolivia_to_world',
    status: 'processing',
    bridge_source_deposit_instructions: {
      type: 'bridge_transfer',
      to_address: 'SoLaNaDepositAddr111111111111111111111111',
      amount_to_deposit: 599.1,
    },
  };

  function makeService(order: any) {
    const updates: Record<string, any[]> = {};
    const inserts: Record<string, any[]> = {};
    const from = jest.fn((table: string) => {
      const query: any = {
        select: jest.fn(() => query),
        update: jest.fn((payload: unknown) => {
          (updates[table] ??= []).push(payload);
          return query;
        }),
        insert: jest.fn(async (payload: unknown) => {
          (inserts[table] ??= []).push(payload);
          return { data: null, error: null };
        }),
        eq: jest.fn(() => query),
        in: jest.fn(() => query),
        limit: jest.fn(async () => ({
          data: table === 'profiles' ? [{ id: 'staff-1' }] : [],
          error: null,
        })),
        maybeSingle: jest.fn(async () => ({
          data: table === 'payment_orders' ? order : null,
          error: null,
        })),
        then: undefined,
      };
      return query;
    });

    const svc = Object.create(WebhooksService.prototype) as any;
    const emitOrderUpdated = jest.fn();
    svc.supabase = { from };
    svc.ordersGateway = { emitOrderUpdated };
    svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    return { svc, updates, inserts, emitOrderUpdated };
  }

  const payload = {
    event_object: {
      id: 'tr_1',
      state: 'underfunded',
      additional_funding_instructions: {
        destination: {
          payment_rail: 'bridge_transfer',
          bridge_transfer_id: 'tr_1',
        },
        amount: '10.00',
      },
    },
  };

  it('guarda las instrucciones de fondeo adicional y avisa al staff sin cambiar el estado', async () => {
    const { svc, updates, inserts, emitOrderUpdated } = makeService(ORDER);

    await svc.handleTransferUnderfunded(payload);

    expect(updates.bridge_transfers[0]).toMatchObject({
      bridge_state: 'underfunded',
    });

    const orderUpdate = updates.payment_orders[0];
    expect(orderUpdate).not.toHaveProperty('status');
    expect(orderUpdate.bridge_source_deposit_instructions).toMatchObject({
      to_address: ORDER.bridge_source_deposit_instructions.to_address,
      bridge_state: 'underfunded',
      additional_funding: { amount: '10.00' },
    });

    expect(inserts.notifications[0][0]).toMatchObject({
      user_id: 'staff-1',
      reference_id: 'order-1',
    });
    expect(emitOrderUpdated).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ id: 'order-1', status: 'processing' }),
    );
  });

  it('sin orden vinculada solo registra el estado del transfer', async () => {
    const { svc, updates, inserts } = makeService(null);

    await svc.handleTransferUnderfunded(payload);

    expect(updates.bridge_transfers).toHaveLength(1);
    expect(updates.payment_orders).toBeUndefined();
    expect(inserts.notifications).toBeUndefined();
  });
});

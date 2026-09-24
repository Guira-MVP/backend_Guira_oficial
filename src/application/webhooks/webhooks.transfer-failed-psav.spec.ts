import { WebhooksService } from './webhooks.service';

/**
 * transfer failed/returned en flujos con depósito PSAV (bolivia_to_world,
 * fiat_bo_to_bridge_wallet).
 *
 * El cliente pagó en BOB a la cuenta PSAV y el Transfer lo fondeó el staff con
 * USDC: nunca hubo reserve_balance. Liberar saldo aquí le acreditaría al
 * cliente dinero que no tiene (release_reserved_balance suma sin verificar).
 */
describe('WebhooksService — transfer fallido en flujos PSAV', () => {
  function makeService(order: Record<string, unknown>) {
    const inserts: Record<string, any[]> = {};
    const from = jest.fn((table: string) => {
      const q: any = { kind: 'select' };
      q.select = jest.fn(() => q);
      q.update = jest.fn(() => {
        q.kind = 'update';
        return q;
      });
      q.insert = jest.fn(async (payload: unknown) => {
        (inserts[table] ??= []).push(payload);
        return { data: null, error: null };
      });
      for (const m of ['eq', 'in', 'order']) q[m] = jest.fn(() => q);
      q.limit = jest.fn(async () => ({
        data: table === 'profiles' ? [{ id: 'staff-1' }] : [],
        error: null,
      }));
      q.single = jest.fn(async () => ({ data: null, error: null }));
      q.maybeSingle = jest.fn(async () => {
        if (table === 'bridge_transfers') {
          return {
            data: {
              id: 'bt-local-1',
              user_id: 'user-1',
              payout_request_id: null,
              amount: '594.88',
              destination_currency: 'mxn',
              status: 'pending',
            },
            error: null,
          };
        }
        if (table === 'payment_orders') return { data: order, error: null };
        return { data: null, error: null };
      });
      q.then = (ok: any, ko: any) =>
        Promise.resolve({ data: null, error: null }).then(ok, ko);
      return q;
    });

    const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
    const svc = Object.create(WebhooksService.prototype) as any;
    svc.supabase = { from, rpc };
    svc.ordersGateway = { emitOrderUpdated: jest.fn() };
    svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn() };
    svc.notifyOrderFinalStatusEmail = jest.fn().mockResolvedValue(undefined);
    return { svc, rpc, inserts };
  }

  const payload = { event_object: { id: 'tr_1', state: 'failed' } };

  it.each(['bolivia_to_world', 'fiat_bo_to_bridge_wallet'])(
    '%s: no libera saldo, avisa la devolución manual y alerta al staff',
    async (flowType) => {
      const { svc, rpc, inserts } = makeService({
        id: 'order-1',
        user_id: 'user-1',
        wallet_id: null,
        amount: '7265.12',
        fee_amount: '217.95',
        currency: 'BOB',
        flow_type: flowType,
        deposit_reference_code: 'G-24092026-123456',
      });

      await svc.handleTransferFailed(payload);

      expect(rpc).not.toHaveBeenCalledWith(
        'release_reserved_balance',
        expect.anything(),
      );

      const notifications = (inserts.notifications ?? []).flat();
      const clientMsg = notifications.find((n: any) => n.user_id === 'user-1');
      expect(clientMsg.message).toContain('devolución de tu depósito');
      expect(clientMsg.message).not.toContain('saldo ha sido devuelto');

      const staffMsg = notifications.find((n: any) => n.user_id === 'staff-1');
      expect(staffMsg.message).toContain('G-24092026-123456');
    },
  );

  it('un flujo con reserva (bridge_wallet_to_fiat_bo) sigue liberando saldo', async () => {
    const { svc, rpc } = makeService({
      id: 'order-2',
      user_id: 'user-1',
      wallet_id: 'wallet-1',
      amount: '1000',
      fee_amount: '30',
      currency: 'USDC',
      flow_type: 'bridge_wallet_to_fiat_bo',
      deposit_reference_code: null,
    });

    await svc.handleTransferFailed(payload);

    expect(rpc).toHaveBeenCalledWith(
      'release_reserved_balance',
      expect.objectContaining({ p_user_id: 'user-1' }),
    );
  });
});

import { ConflictException } from '@nestjs/common';
import { SuppliersService } from './suppliers.service';

/**
 * Un beneficiario con transacciones no se puede eliminar: se conserva por
 * trazabilidad. ACH y Wire son la misma cuenta bancaria de EE. UU., así que un
 * pago por cualquiera de los dos bloquea el borrado de ambos.
 */

const USER = 'user-1';

interface SupplierRow {
  id: string;
  user_id: string;
  payment_rail: string;
  contact_email: string | null;
  bridge_external_account_id: string | null;
  is_active: boolean;
}

interface MockOptions {
  suppliers: SupplierRow[];
  /** supplier_id con filas en payment_orders */
  orders?: string[];
  /** supplier_id con filas en payout_requests */
  payouts?: string[];
  ordersError?: string;
}

function mockSupabase(opts: MockOptions) {
  const updates: Array<{ table: string; values: unknown }> = [];
  const inserts: Array<{ table: string; values: unknown }> = [];

  function builder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const getEq = (col: string) => eqs.find(([c]) => c === col)?.[1];
    const getIn = (col: string) => ins.find(([c]) => c === col)?.[1];

    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        eqs.push([col, val]);
        return b;
      },
      in: (col: string, vals: unknown[]) => {
        ins.push([col, vals]);
        return b;
      },
      limit: () => b,
      update: (values: unknown) => {
        updates.push({ table, values });
        return b;
      },
      insert: (values: unknown) => {
        inserts.push({ table, values });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (table === 'suppliers') {
          const rails = getIn('payment_rail') as string[] | undefined;
          const rows = opts.suppliers.filter(
            (s) =>
              s.user_id === getEq('user_id') &&
              (getEq('is_active') === undefined || s.is_active === getEq('is_active')) &&
              (!rails || rails.includes(s.payment_rail)),
          );
          return resolve({ data: rows, error: null });
        }
        if (table === 'payment_orders' || table === 'payout_requests') {
          if (table === 'payment_orders' && opts.ordersError) {
            return resolve({ data: null, error: { message: opts.ordersError } });
          }
          const withTx = (table === 'payment_orders' ? opts.orders : opts.payouts) ?? [];
          const ids = (getIn('supplier_id') as string[]) ?? [];
          const hit = ids.find((id) => withTx.includes(id));
          return resolve({ data: hit ? [{ supplier_id: hit }] : [], error: null });
        }
        return resolve({ data: null, error: null });
      },
    };
    return b;
  }

  const supabase: any = { from: jest.fn((table: string) => builder(table)) };
  return { supabase, updates, inserts };
}

function makeService(opts: MockOptions) {
  const { supabase, updates, inserts } = mockSupabase(opts);
  const service = new SuppliersService(supabase, {} as any, {} as any, {} as any);
  // findOne arrastra el mapeo de Bridge y el fee de la LA, que aquí no importan.
  jest.spyOn(service, 'findOne').mockImplementation(async (id: string) => {
    const row = opts.suppliers.find((s) => s.id === id);
    return { ...row, name: 'Miguel' } as any;
  });
  return { service, updates, inserts };
}

function row(partial: Partial<SupplierRow> & { id: string; payment_rail: string }): SupplierRow {
  return {
    user_id: USER,
    contact_email: 'miguel@test.com',
    bridge_external_account_id: null,
    is_active: true,
    ...partial,
  };
}

async function expectBlocked(promise: Promise<unknown>, linkedRail: string | null) {
  const err = (await promise.catch((e: unknown) => e)) as ConflictException;
  expect(err).toBeInstanceOf(ConflictException);
  expect(err.getResponse()).toMatchObject({
    code: 'SUPPLIER_HAS_TRANSACTIONS',
    linked_rail: linkedRail,
  });
}

describe('SuppliersService — borrado de beneficiarios con transacciones', () => {
  const ach = row({ id: 'ach-1', payment_rail: 'ach', bridge_external_account_id: 'ea-1' });
  const wire = row({ id: 'wire-1', payment_rail: 'wire', bridge_external_account_id: 'ea-1' });
  const pe = row({ id: 'pe-1', payment_rail: 'pe_bank_transfer' });
  const crypto = row({ id: 'crypto-1', payment_rail: 'crypto' });

  it('bloquea si la cuenta tiene una orden', async () => {
    const { service, updates } = makeService({ suppliers: [pe], orders: ['pe-1'] });
    await expectBlocked(service.remove('pe-1', USER), null);
    expect(updates).toHaveLength(0);
  });

  it('bloquea si la cuenta solo tiene un payout', async () => {
    const { service, updates } = makeService({ suppliers: [crypto], payouts: ['crypto-1'] });
    await expectBlocked(service.remove('crypto-1', USER), null);
    expect(updates).toHaveLength(0);
  });

  it('sin transacciones desactiva y audita como antes', async () => {
    const { service, updates, inserts } = makeService({ suppliers: [pe] });
    await expect(service.remove('pe-1', USER)).resolves.toEqual({
      message: 'Proveedor desactivado',
    });
    expect(updates).toEqual([
      { table: 'suppliers', values: expect.objectContaining({ is_active: false }) },
    ]);
    expect(inserts[0]).toMatchObject({
      table: 'audit_logs',
      values: expect.objectContaining({ action: 'DEACTIVATE_SUPPLIER' }),
    });
  });

  it('un pago por ACH bloquea el borrado de Wire', async () => {
    const { service, updates } = makeService({ suppliers: [ach, wire], orders: ['ach-1'] });
    await expectBlocked(service.remove('wire-1', USER), 'ach');
    expect(updates).toHaveLength(0);
  });

  it('un pago por Wire bloquea el borrado de ACH', async () => {
    const { service } = makeService({ suppliers: [ach, wire], payouts: ['wire-1'] });
    await expectBlocked(service.remove('ach-1', USER), 'wire');
  });

  it('reconoce al hermano por email aunque la external account sea otra', async () => {
    const wireOtherEa = row({
      id: 'wire-2',
      payment_rail: 'wire',
      contact_email: 'MIGUEL@test.com ',
      bridge_external_account_id: 'ea-2',
    });
    const { service } = makeService({ suppliers: [ach, wireOtherEa], orders: ['ach-1'] });
    await expectBlocked(service.remove('wire-2', USER), 'ach');
  });

  it('no mezcla ACH/Wire de otro contacto', async () => {
    const otherAch = row({
      id: 'ach-9',
      payment_rail: 'ach',
      contact_email: 'otra@test.com',
      bridge_external_account_id: 'ea-9',
    });
    const { service } = makeService({ suppliers: [wire, otherAch], orders: ['ach-9'] });
    await expect(service.remove('wire-1', USER)).resolves.toBeDefined();
  });

  it('las órdenes a otras cuentas del mismo contacto no bloquean ACH/Wire', async () => {
    const { service } = makeService({
      suppliers: [ach, wire, pe, crypto],
      orders: ['pe-1'],
      payouts: ['crypto-1'],
    });
    await expect(service.remove('wire-1', USER)).resolves.toBeDefined();
  });

  it('si la consulta de órdenes falla, no borra', async () => {
    const { service, updates } = makeService({ suppliers: [pe], ordersError: 'boom' });
    await expect(service.remove('pe-1', USER)).rejects.toThrow();
    expect(updates).toHaveLength(0);
  });

  describe('getDeletionStatus', () => {
    it('deletable=true sin transacciones', async () => {
      const { service } = makeService({ suppliers: [ach, wire] });
      await expect(service.getDeletionStatus('wire-1', USER)).resolves.toEqual({
        deletable: true,
        reason: null,
        linked_rail: null,
      });
    });

    it('deletable=false con el riel hermano que tiene los movimientos', async () => {
      const { service } = makeService({ suppliers: [ach, wire], orders: ['ach-1'] });
      await expect(service.getDeletionStatus('wire-1', USER)).resolves.toEqual({
        deletable: false,
        reason: 'HAS_TRANSACTIONS',
        linked_rail: 'ach',
      });
    });
  });
});

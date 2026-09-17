import { BadRequestException } from '@nestjs/common';
import { SuppliersService } from './suppliers.service';

/**
 * Pruebas de `listByUserAdmin`, la agenda de beneficiarios del panel de
 * staff.
 *
 * Lo que se protege aquí es justo lo que motivó el método: que un
 * beneficiario de rail manual (sin liquidation address) siga apareciendo, que
 * una referencia a una LA que no existe en la DB local no reviente sino que
 * se marque como tal, y que la búsqueda funcione en el servidor y no sobre la
 * página ya cargada (la limitación que tenía el panel de Liquidación).
 */

interface SupplierRow {
  id: string;
  user_id: string;
  name: string | null;
  contact_email?: string | null;
  payment_rail: string;
  currency?: string;
  is_active: boolean;
  compliance_status: string | null;
  bridge_liquidation_address_id: string | null;
  bank_details?: Record<string, unknown> | null;
}

interface LiquidationAddressRow {
  id: string;
  bridge_liquidation_address_id: string;
  user_id: string;
  address: string;
  chain: string;
  currency: string;
  destination_payment_rail: string | null;
  destination_currency: string | null;
  is_active: boolean;
  developer_fee_percent: string | null;
}

interface MockOptions {
  suppliers?: SupplierRow[];
  liquidationAddresses?: LiquidationAddressRow[];
  suppliersError?: string;
  countError?: string;
  laError?: string;
}

interface RecordedQuery {
  table: string;
  isCountQuery: boolean;
  calls: Record<string, unknown[][]>;
}

function mockSupabase(opts: MockOptions) {
  const suppliers = opts.suppliers ?? [];
  const las = opts.liquidationAddresses ?? [];
  const queries: RecordedQuery[] = [];

  function builder(table: string) {
    const calls: Record<string, unknown[][]> = {};
    let isCountQuery = false;
    const record = (method: string, args: unknown[]) => {
      (calls[method] ??= []).push(args);
    };
    const getEq = (col: string) =>
      (calls.eq ?? []).find(([c]) => c === col)?.[1];

    const b: any = {
      select: (...args: unknown[]) => {
        record('select', args);
        const selectOpts = args[1] as { head?: boolean } | undefined;
        if (selectOpts?.head) isCountQuery = true;
        return b;
      },
      eq: (...args: unknown[]) => {
        record('eq', args);
        return b;
      },
      in: (...args: unknown[]) => {
        record('in', args);
        return b;
      },
      or: (...args: unknown[]) => {
        record('or', args);
        return b;
      },
      order: (...args: unknown[]) => {
        record('order', args);
        return b;
      },
      range: (...args: unknown[]) => {
        record('range', args);
        return b;
      },
      then: (resolve: (v: unknown) => unknown) => {
        queries.push({ table, isCountQuery, calls });

        if (table === 'suppliers') {
          if (opts.suppliersError) {
            return resolve({
              data: null,
              error: { message: opts.suppliersError },
              count: null,
            });
          }

          let rows = suppliers.filter((s) => s.user_id === getEq('user_id'));

          const rail = getEq('payment_rail');
          if (rail !== undefined)
            rows = rows.filter((s) => s.payment_rail === rail);

          const isActive = getEq('is_active');
          if (isActive !== undefined)
            rows = rows.filter((s) => s.is_active === isActive);

          const complianceStatus = getEq('compliance_status');
          if (complianceStatus !== undefined)
            rows = rows.filter((s) => s.compliance_status === complianceStatus);

          const orArg = calls.or?.[0]?.[0] as string | undefined;
          if (orArg) {
            const term =
              /name\.ilike\.%(.*)%,contact_email/.exec(orArg)?.[1] ?? '';
            const needle = term.toLowerCase();
            rows = rows.filter(
              (s) =>
                (s.name ?? '').toLowerCase().includes(needle) ||
                (s.contact_email ?? '').toLowerCase().includes(needle),
            );
          }

          if (isCountQuery) {
            if (opts.countError) {
              return resolve({
                data: null,
                error: { message: opts.countError },
                count: null,
              });
            }
            return resolve({ data: null, error: null, count: rows.length });
          }

          const rangeArgs = calls.range?.[0] as [number, number] | undefined;
          if (rangeArgs) rows = rows.slice(rangeArgs[0], rangeArgs[1] + 1);
          return resolve({ data: rows, error: null });
        }

        if (table === 'bridge_liquidation_addresses') {
          if (opts.laError) {
            return resolve({ data: null, error: { message: opts.laError } });
          }
          const ids = (calls.in?.[0]?.[1] as string[]) ?? [];
          const userId = getEq('user_id');
          const rows = las.filter(
            (la) =>
              ids.includes(la.bridge_liquidation_address_id) &&
              la.user_id === userId,
          );
          return resolve({ data: rows, error: null });
        }

        return resolve({ data: [], error: null });
      },
    };

    return b;
  }

  const supabase: any = { from: jest.fn((table: string) => builder(table)) };
  return { supabase, queries };
}

function makeService(opts: MockOptions = {}) {
  const { supabase, queries } = mockSupabase(opts);
  // bridgeService, walletScreening y notifications no se usan en
  // listByUserAdmin — no hace falta simularlos.
  const service = new SuppliersService(
    supabase,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, queries };
}

/** Encuentra la consulta de datos (no de conteo) contra `suppliers`. */
function dataQuery(queries: RecordedQuery[]) {
  return queries.find((q) => q.table === 'suppliers' && !q.isCountQuery);
}

describe('SuppliersService.listByUserAdmin', () => {
  const supplier = (overrides: Partial<SupplierRow> = {}): SupplierRow => ({
    id: overrides.id ?? 'sup-1',
    user_id: 'user-1',
    name: 'Beneficiario',
    contact_email: 'beneficiario@example.com',
    payment_rail: 'ach',
    currency: 'usd',
    is_active: true,
    compliance_status: null,
    bridge_liquidation_address_id: null,
    ...overrides,
  });

  const la = (
    overrides: Partial<LiquidationAddressRow> = {},
  ): LiquidationAddressRow => ({
    id: 'la-row-1',
    bridge_liquidation_address_id: 'la-1',
    user_id: 'user-1',
    address: '0xabc',
    chain: 'solana',
    currency: 'usdc',
    destination_payment_rail: null,
    destination_currency: null,
    is_active: true,
    developer_fee_percent: '1.5',
    ...overrides,
  });

  it('adjunta la liquidation address y su fee cuando el beneficiario tiene una', async () => {
    const { service } = makeService({
      suppliers: [
        supplier({ id: 'sup-crypto', bridge_liquidation_address_id: 'la-1' }),
      ],
      liquidationAddresses: [la()],
    });

    const result = await service.listByUserAdmin('user-1');

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].liquidation_address).toMatchObject({
      bridge_liquidation_address_id: 'la-1',
      address: '0xabc',
      chain: 'solana',
      is_active: true,
    });
    expect(result.data[0].developer_fee_percent).toBe(1.5);
  });

  it('no rompe con beneficiarios de rail manual, que nunca tienen liquidation address', async () => {
    const { service } = makeService({
      suppliers: [
        supplier({
          id: 'sup-manual',
          payment_rail: 'pe_bank_transfer',
          bridge_liquidation_address_id: null,
        }),
      ],
    });

    const result = await service.listByUserAdmin('user-1');

    expect(result.total).toBe(1);
    expect(result.data[0].liquidation_address).toBeNull();
    expect(result.data[0].developer_fee_percent).toBeNull();
  });

  it('marca como null (no revienta) la liquidation address referenciada que no existe en la DB local', async () => {
    const { service } = makeService({
      suppliers: [
        supplier({
          id: 'sup-orphan',
          payment_rail: 'ach',
          bridge_liquidation_address_id: 'la-huerfana',
        }),
      ],
      liquidationAddresses: [], // la-huerfana no está aquí: inconsistencia real
    });

    const result = await service.listByUserAdmin('user-1');

    expect(result.data[0].liquidation_address).toBeNull();
    // El id de referencia se conserva: es lo que permite a la UI distinguir
    // este caso ("Sin sincronizar") del beneficiario manual ("Manual").
    expect(result.data[0].bridge_liquidation_address_id).toBe('la-huerfana');
  });

  it('trae solo los beneficiarios del usuario indicado', async () => {
    const { service } = makeService({
      suppliers: [
        supplier({ id: 'sup-mine', user_id: 'user-1' }),
        supplier({ id: 'sup-other', user_id: 'user-2' }),
      ],
    });

    const result = await service.listByUserAdmin('user-1');

    expect(result.data.map((s) => s.id)).toEqual(['sup-mine']);
  });

  describe('paginación', () => {
    it('usa page=1, limit=20 por defecto', async () => {
      const { service, queries } = makeService({ suppliers: [] });

      await service.listByUserAdmin('user-1');

      const q = dataQuery(queries);
      expect(q?.calls.range?.[0]).toEqual([0, 19]);
    });

    it('calcula el rango a partir de page/limit', async () => {
      const { service, queries } = makeService({ suppliers: [] });

      await service.listByUserAdmin('user-1', { page: 3, limit: 10 });

      const q = dataQuery(queries);
      expect(q?.calls.range?.[0]).toEqual([20, 29]);
    });

    it('acota page < 1 y limit fuera de [1, 100]', async () => {
      const { service, queries } = makeService({ suppliers: [] });

      await service.listByUserAdmin('user-1', { page: 0, limit: 500 });

      const q = dataQuery(queries);
      // page=0 → 1 (from=0); limit=500 → 100 (hasta el índice 99)
      expect(q?.calls.range?.[0]).toEqual([0, 99]);
    });
  });

  describe('filtros', () => {
    it('filtra por rail', async () => {
      const { service } = makeService({
        suppliers: [
          supplier({ id: 'sup-ach', payment_rail: 'ach' }),
          supplier({ id: 'sup-crypto', payment_rail: 'crypto' }),
        ],
      });

      const result = await service.listByUserAdmin('user-1', {
        rail: 'crypto',
      });

      expect(result.data.map((s) => s.id)).toEqual(['sup-crypto']);
    });

    it('status=active / inactive filtran por is_active', async () => {
      const { service } = makeService({
        suppliers: [
          supplier({ id: 'sup-on', is_active: true }),
          supplier({ id: 'sup-off', is_active: false }),
        ],
      });

      const active = await service.listByUserAdmin('user-1', {
        status: 'active',
      });
      expect(active.data.map((s) => s.id)).toEqual(['sup-on']);

      const inactive = await service.listByUserAdmin('user-1', {
        status: 'inactive',
      });
      expect(inactive.data.map((s) => s.id)).toEqual(['sup-off']);
    });

    it('status=blocked / pending_review filtran por compliance_status', async () => {
      const { service } = makeService({
        suppliers: [
          supplier({ id: 'sup-blocked', compliance_status: 'blocked' }),
          supplier({ id: 'sup-pending', compliance_status: 'pending_review' }),
          supplier({ id: 'sup-clean', compliance_status: null }),
        ],
      });

      const blocked = await service.listByUserAdmin('user-1', {
        status: 'blocked',
      });
      expect(blocked.data.map((s) => s.id)).toEqual(['sup-blocked']);

      const pending = await service.listByUserAdmin('user-1', {
        status: 'pending_review',
      });
      expect(pending.data.map((s) => s.id)).toEqual(['sup-pending']);
    });

    it('busca en el servidor por nombre o email, no sobre la página ya cargada', async () => {
      const { service } = makeService({
        suppliers: [
          supplier({
            id: 'sup-juan',
            name: 'Juan Pérez',
            contact_email: 'juan@x.com',
          }),
          supplier({
            id: 'sup-maria',
            name: 'María Gómez',
            contact_email: 'maria@x.com',
          }),
        ],
      });

      const result = await service.listByUserAdmin('user-1', {
        search: 'juan',
      });

      expect(result.data.map((s) => s.id)).toEqual(['sup-juan']);
    });

    it('sanea caracteres que romperían el filtro .or() de PostgREST', async () => {
      const { service, queries } = makeService({ suppliers: [] });

      await service.listByUserAdmin('user-1', {
        search: 'John % Doe (evil), inc',
      });

      const q = dataQuery(queries);
      const orArg = q?.calls.or?.[0]?.[0] as string;
      expect(orArg).toBe(
        'name.ilike.%John  Doe evil inc%,contact_email.ilike.%John  Doe evil inc%',
      );
    });

    it('una búsqueda vacía no agrega el filtro .or()', async () => {
      const { service, queries } = makeService({ suppliers: [] });

      await service.listByUserAdmin('user-1', { search: '   ' });

      const q = dataQuery(queries);
      expect(q?.calls.or).toBeUndefined();
    });
  });

  describe('manejo de errores', () => {
    it('propaga un error de la consulta principal como BadRequestException', async () => {
      const { service } = makeService({ suppliersError: 'conexión perdida' });

      await expect(service.listByUserAdmin('user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('un error solo en el conteo no interrumpe la respuesta', async () => {
      const { service } = makeService({
        suppliers: [supplier({ id: 'sup-1' })],
        countError: 'timeout',
      });

      const result = await service.listByUserAdmin('user-1');

      expect(result.data).toHaveLength(1);
      // Sin count fiable, se usa el tamaño de la página como aproximación.
      expect(result.total).toBe(1);
    });
  });
});

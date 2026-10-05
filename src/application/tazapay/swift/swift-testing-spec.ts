/**
 * Utilidades de prueba para los servicios SWIFT: una DB en memoria con la
 * forma mínima del cliente de Supabase que usan esos servicios, y la metadata
 * real de Tazapay (sandbox = producción, 2026-09-29) como fixtures.
 *
 * Solo para specs (el sufijo -spec.ts lo deja fuera del build y jest no lo
 * corre como suite porque no termina en .spec.ts).
 */

type Row = Record<string, any>;

export function createMemoryDb(initial: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [t, rows] of Object.entries(initial))
    tables[t] = rows.map((r) => ({ ...r }));
  let seq = 0;
  const calls: Array<{ table: string; op: string; payload?: unknown }> = [];

  const getPath = (row: Row, path: string) => {
    const m = /^(\w+)->>(\w+)$/.exec(path);
    if (m) return row[m[1]]?.[m[2]];
    return row[path];
  };

  function from(table: string) {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let payload: any = null;
    let limitN: number | null = null;
    let upsertConflict: string[] = [];

    const matching = () =>
      tables[table].filter((r) => filters.every((f) => f(r)));

    const execute = (): { data: any; error: any } => {
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map(
          (p: Row) => ({
            id: p.id ?? `${table}-${++seq}`,
            created_at: p.created_at ?? new Date().toISOString(),
            updated_at: p.updated_at ?? new Date().toISOString(),
            attempt_count: table === 'tazapay_beneficiaries' ? 0 : undefined,
            ...p,
          }),
        );
        tables[table].push(...list);
        return { data: Array.isArray(payload) ? list : list[0], error: null };
      }
      if (op === 'upsert') {
        const existing = tables[table].find((r) =>
          upsertConflict.every((c) => r[c] === payload[c]),
        );
        if (existing) Object.assign(existing, payload);
        else tables[table].push({ id: `${table}-${++seq}`, ...payload });
        return { data: null, error: null };
      }
      const rows = matching();
      if (op === 'update') {
        rows.forEach((r) => Object.assign(r, payload));
        return { data: rows, error: null };
      }
      if (op === 'delete') {
        tables[table] = tables[table].filter((r) => !rows.includes(r));
        if (table === 'suppliers') {
          const ids = new Set(rows.map((r) => r.id));
          tables.tazapay_beneficiaries = (
            tables.tazapay_beneficiaries ?? []
          ).filter((r) => !ids.has(r.supplier_id));
        }
        return { data: null, error: null };
      }
      return {
        data: limitN !== null ? rows.slice(0, limitN) : rows,
        error: null,
      };
    };

    const b: any = {
      select: () => b,
      insert: (p: unknown) => {
        op = 'insert';
        payload = p;
        calls.push({ table, op, payload: p });
        return b;
      },
      update: (p: unknown) => {
        op = 'update';
        payload = p;
        calls.push({ table, op, payload: p });
        return b;
      },
      delete: () => {
        op = 'delete';
        calls.push({ table, op });
        return b;
      },
      upsert: (p: unknown, opts?: { onConflict?: string }) => {
        op = 'upsert';
        payload = p;
        upsertConflict = (opts?.onConflict ?? 'id').split(',');
        calls.push({ table, op, payload: p });
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => getPath(r, col) === val);
        return b;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(getPath(r, col)));
        return b;
      },
      not: (col: string, _op: string, val: unknown) => {
        filters.push((r) =>
          val === null
            ? r[col] !== null && r[col] !== undefined
            : r[col] !== val,
        );
        return b;
      },
      lt: (col: string, val: string) => {
        filters.push((r) => String(r[col]) < val);
        return b;
      },
      filter: (col: string, _op: string, val: unknown) => {
        filters.push((r) => getPath(r, col) === val);
        return b;
      },
      order: () => b,
      limit: (n: number) => {
        limitN = n;
        return b;
      },
      maybeSingle: async () => {
        const { data, error } = execute();
        const row = Array.isArray(data) ? (data[0] ?? null) : data;
        return { data: row, error };
      },
      single: async () => {
        const { data, error } = execute();
        const row = Array.isArray(data) ? (data[0] ?? null) : data;
        return {
          data: row,
          error: row ? error : (error ?? { message: 'not found' }),
        };
      },
      then: (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => Promise.resolve(execute()).then(resolve, reject),
    };
    return b;
  }

  return { client: { from } as any, tables, calls };
}

/** Respuesta real de la metadata SWIFT para CN (sandbox y producción, 2026-09-29). */
export const METADATA_CN = {
  status: 'success',
  data: {
    payout_methods: [
      {
        beneficiary_type: ['individual', 'business'],
        country: 'CN',
        currency: 'USD',
        payout_type: 'swift',
        supported_modes: [],
        fund_transfer_networks: [
          {
            name: 'cross_border_wire',
            transfer_limit: {
              currency: 'USD',
              minimum: 100,
              maximum: 100000000,
            },
          },
        ],
        recommended_fields: {
          recommended_bank_codes: [],
          recommended_bank_fields: [],
          recommended_beneficiary_fields: [
            'address.line1',
            'address.city',
            'address.state',
            'address.postal_code',
          ],
        },
        required_bank_codes: ['swift_code'],
        required_bank_fields: [
          'account_holder_name',
          'bank_name',
          'account_number',
        ],
        required_beneficiary_fields: [],
        transfer_limit: { currency: 'USD', minimum: 100, maximum: 10000000000 },
      },
    ],
  },
};

/** PE/PEN en producción: mismo esquema, sin redes. */
export const METADATA_PE = {
  status: 'success',
  data: {
    payout_methods: [
      {
        beneficiary_type: ['individual', 'business'],
        country: 'PE',
        currency: 'USD',
        payout_type: 'swift',
        supported_modes: [],
        fund_transfer_networks: [{ name: 'cross_border_wire' }],
        required_bank_codes: ['swift_code'],
        required_bank_fields: [
          'account_holder_name',
          'bank_name',
          'account_number',
        ],
        required_beneficiary_fields: [],
      },
      {
        beneficiary_type: ['individual', 'business'],
        country: 'PE',
        currency: 'PEN',
        payout_type: 'swift',
        supported_modes: [],
        fund_transfer_networks: [],
        required_bank_codes: ['swift_code'],
        required_bank_fields: [
          'account_holder_name',
          'bank_name',
          'account_number',
        ],
        required_beneficiary_fields: [],
        transfer_limit: { currency: 'PEN', minimum: 100, maximum: 10000000000 },
      },
      {
        beneficiary_type: ['individual', 'business'],
        country: 'PE',
        currency: 'PEN',
        payout_type: 'local',
      },
    ],
  },
};

/** Reglas de la carga inicial que afectan a los fixtures. */
export const SEED_RULES = [
  {
    country: 'CN',
    currency: null,
    beneficiary_type: null,
    rule_type: 'require_field',
    field_key: 'phone',
    value: {},
    message_es: 'China exige el teléfono móvil del beneficiario.',
    is_active: true,
  },
  {
    country: 'CN',
    currency: null,
    beneficiary_type: null,
    rule_type: 'field_pattern',
    field_key: 'phone.number',
    value: { pattern: '^1[3-9][0-9]{9}$' },
    message_es: 'Debe ser un móvil chino.',
    is_active: true,
  },
  {
    country: 'CN',
    currency: null,
    beneficiary_type: null,
    rule_type: 'recommend_field',
    field_key: 'name_local',
    value: {},
    message_es: null,
    is_active: true,
  },
  {
    country: 'BO',
    currency: 'BOB',
    beneficiary_type: null,
    rule_type: 'blocked_swift_codes',
    field_key: 'bank_codes.swift_code',
    value: { codes: ['BSCBFBO2XXX', 'BSCBFBO2'] },
    message_es: 'Sin Fassil.',
    is_active: true,
  },
];

/** Campos válidos de un proveedor chino en USD. */
export const CN_USD_FIELDS = {
  'bank.account_holder_name': 'Shenzhen Hongda Trading Co., Ltd.',
  'bank.account_number': '7550 1234 5678 9012',
  'bank.bank_name': 'China Merchants Bank',
  'bank_codes.swift_code': 'cmbccnbs',
  'phone.calling_code': '86',
  'phone.number': '13800138000',
  'address.line1': 'No. 88 Shennan Road',
  'address.city': 'Shenzhen',
};

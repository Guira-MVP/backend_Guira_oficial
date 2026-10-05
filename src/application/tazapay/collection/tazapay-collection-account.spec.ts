import { TazapayApiError } from '../tazapay-api.client';
import {
  collectStatus,
  CollectionWalletError,
  parseCollectionAccount,
  TazapayCollectionAccountService,
  tazapayErrorCode,
} from './tazapay-collection-account.service';

type Row = Record<string, unknown>;

/** Supabase en memoria: lo justo para las consultas del servicio. */
function fakeSupabase(tables: Record<string, Row[]>) {
  let seq = 0;
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'insert' | 'upsert' = 'select';
    let payload: Row = {};
    let conflictKey = '';
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const run = (): { data: unknown; error: unknown } => {
      if (op === 'insert') {
        const unique = table === 'tazapay_collection_accounts';
        if (
          unique &&
          tables[table].some(
            (r) =>
              r.user_id === payload.user_id &&
              r.payment_method_type === payload.payment_method_type &&
              r.chain === payload.chain,
          )
        )
          return { data: null, error: { code: '23505', message: 'dup' } };
        const row = {
          id: `row-${++seq}`,
          request_status: 'pending',
          account_status: 'pending',
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          ...payload,
        };
        tables[table].push(row);
        return { data: [row], error: null };
      }
      if (op === 'upsert') {
        const existing = tables[table].find(
          (r) => r[conflictKey] === payload[conflictKey],
        );
        if (existing) Object.assign(existing, payload);
        else tables[table].push({ ...payload });
        return { data: null, error: null };
      }
      if (op === 'update') {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      }
      return { data: rows(), error: null };
    };
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      in: (k: string, v: unknown[]) => (
        filters.push((r) => v.includes(r[k])),
        b
      ),
      not: (k: string) => (filters.push((r) => r[k] != null), b),
      order: () => b,
      limit: () => b,
      // Paginación: devuelve la página y el total (count: 'exact').
      range: (from: number, to: number) => {
        const all = rows();
        return Promise.resolve({
          data: all.slice(from, to + 1),
          count: all.length,
          error: null,
        });
      },
      insert: (p: Row) => ((op = 'insert'), (payload = p), b),
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      upsert: (p: Row, o: { onConflict: string }) => {
        op = 'upsert';
        payload = p;
        conflictKey = o.onConflict;
        return Promise.resolve(run());
      },
      maybeSingle: () => {
        const r = run();
        return Promise.resolve({
          data: (r.data as Row[] | null)?.[0] ?? null,
          error: r.error,
        });
      },
      single: () => {
        const r = run();
        return Promise.resolve({
          data: (r.data as Row[] | null)?.[0] ?? null,
          error: r.error,
        });
      },
      then: (res: (v: unknown) => unknown) => res(run()),
    });
    return b;
  };
  return { from };
}

const USER = '11111111-1111-1111-1111-111111111111';
const ENT = 'ent_test0000000000000000';

const METADATA = {
  status: 'success',
  data: {
    capabilities: [
      {
        payment_method_type: 'stablecoin_usdc',
        type: ['Ethereum', 'Solana', 'Polygon Pos'],
        transfer_limit: {
          min_limit: 1000,
          max_limit: 50000000,
          currency: 'USD',
        },
        on_behalf_of: { supported: true },
        restricted_remitter_countries: ['US'],
        setup_time: 'instant',
      },
    ],
  },
};

const CREATED = {
  status: 'success',
  data: {
    id: 'cwa_new',
    object: 'wallet',
    type: 'wallet',
    payment_method_type: 'stablecoin_usdc',
    status: 'disabled',
    entity_id: ENT,
    requests: [{ id: 'cwar_new', type: 'enable', status: 'processing' }],
    fee_details: { one_time_setup_fee: 0, maintenance_fee: 0 },
  },
};

function setup(opts: { listed?: unknown[]; createError?: Error } = {}) {
  const tables: Record<string, Row[]> = {
    provider_accounts: [
      {
        user_id: USER,
        provider: 'tazapay',
        external_id: ENT,
        status: 'approved',
      },
    ],
    profiles: [{ id: USER, full_name: 'Innova Tecnologia' }],
    tazapay_collection_accounts: [],
    tazapay_collects: [],
  };
  const api = {
    isConfigured: true,
    get: jest.fn((path: string) => {
      if (path.startsWith('/v3/collection_account?'))
        return Promise.resolve({ status: 'success', data: opts.listed ?? [] });
      if (path.startsWith('/v3/metadata/collection_account/wallet'))
        return Promise.resolve(METADATA);
      return Promise.resolve({});
    }),
    post: jest.fn(() =>
      opts.createError
        ? Promise.reject(opts.createError)
        : Promise.resolve(CREATED),
    ),
  };
  const service = new TazapayCollectionAccountService(
    fakeSupabase(tables) as never,
    api as never,
  );
  return { service, api, tables };
}

describe('Tazapay — wallet de fondeo (collection account)', () => {
  it('crea la wallet USDC/Solana on_behalf_of con clave de idempotencia fija', async () => {
    const { service, api, tables } = setup();
    await service.ensureCollectionWallet(USER);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, body, key] = api.post.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(path).toBe('/v3/collection_account');
    expect(body).toMatchObject({
      type: 'wallet',
      payment_method_type: 'stablecoin_usdc',
      // La red tal como la escribe la metadata de Tazapay.
      wallet: { type: 'Solana' },
      on_behalf_of: ENT,
    });
    expect(key).toBe(`tz_cwa_${USER}_stablecoin_usdc_solana`);

    const row = tables.tazapay_collection_accounts[0];
    expect(row).toMatchObject({
      collection_account_id: 'cwa_new',
      enable_request_id: 'cwar_new',
      account_status: 'disabled',
      request_status: 'processing',
      transfer_limit_min: 1000,
      setup_time: 'instant',
    });
  });

  it('si ya existe la devuelve sin volver a crear (irreversible y con costo)', async () => {
    const { service, api } = setup();
    await service.ensureCollectionWallet(USER);
    await service.ensureCollectionWallet(USER);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('adopta la wallet que ya existe en Tazapay en lugar de crear otra', async () => {
    const { service, api, tables } = setup({
      listed: [
        {
          id: 'cwa_old',
          type: 'wallet',
          payment_method_type: 'stablecoin_usdc',
          status: 'enabled',
          wallet: { type: 'Solana', deposit_address: 'SoLAddr' },
          requests: [{ id: 'cwar_old', type: 'enable', status: 'succeeded' }],
        },
      ],
    });
    await service.ensureCollectionWallet(USER);
    expect(api.post).not.toHaveBeenCalled();
    expect(tables.tazapay_collection_accounts[0]).toMatchObject({
      collection_account_id: 'cwa_old',
      deposit_address: 'SoLAddr',
      account_status: 'enabled',
      request_status: 'succeeded',
    });
  });

  it('6121 (sin saldo para la comisión) deja la wallet en failed con motivo', async () => {
    const { service, tables } = setup({
      createError: new TazapayApiError(
        'Tazapay POST /v3/collection_account falló [400]',
        400,
        false,
        '{"status":"error","errors":[{"code":6121,"message":"Insufficient balance"}]}',
      ),
    });
    await expect(service.ensureCollectionWallet(USER)).rejects.toThrow();
    expect(tables.tazapay_collection_accounts[0]).toMatchObject({
      request_status: 'failed',
      failure_code: '6121',
    });
  });

  it('no crea si la entity no está aprobada', async () => {
    const { service, api, tables } = setup();
    tables.provider_accounts[0].status = 'submitted';
    await expect(service.ensureCollectionWallet(USER)).rejects.toBeInstanceOf(
      CollectionWalletError,
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('webhook creation_succeeded guarda la dirección y habilita', async () => {
    const { service, tables } = setup();
    await service.ensureCollectionWallet(USER);
    await service.applyCollectionAccountEvent(
      'collection_account.creation_succeeded',
      {
        data: {
          id: 'cwa_new',
          object: 'collection_account',
          type: 'wallet',
          payment_method_type: 'stablecoin_usdc',
          status: 'enabled',
          wallet: { type: 'solana', deposit_address: 'DepositAddr123' },
          requests: [{ id: 'cwar_new', type: 'enable', status: 'succeeded' }],
        },
      },
    );
    expect(tables.tazapay_collection_accounts[0]).toMatchObject({
      deposit_address: 'DepositAddr123',
      account_status: 'enabled',
      request_status: 'succeeded',
    });
  });

  it('collect.succeeded se registra a nombre del cliente dueño de la wallet', async () => {
    const { service, tables } = setup();
    await service.ensureCollectionWallet(USER);
    await service.applyCollectEvent('collect.succeeded', {
      data: {
        id: 'col_1',
        amount: 100000,
        currency: 'USD',
        status: 'succeeded',
        type: 'stablecoin_usdc',
        destination: 'cwa_new',
        on_behalf_of: ENT,
        holding_currency: 'USD',
        payer_details: {
          payer_wallet: { type: 'Solana', deposit_address: 'PsavAddr' },
        },
        tracking_details: { transaction_hash: '0xabc' },
      },
    });
    expect(tables.tazapay_collects[0]).toMatchObject({
      collect_id: 'col_1',
      user_id: USER,
      status: 'succeeded',
      amount: 100000,
      payer_wallet: 'PsavAddr',
      tx_hash: '0xabc',
    });

    // Un depósito a una cuenta que no es wallet de fondeo se ignora.
    await service.applyCollectEvent('collect.succeeded', {
      data: { id: 'col_2', destination: 'cwa_otra' },
    });
    expect(tables.tazapay_collects).toHaveLength(1);
  });

  it('depósitos paginados del cliente, con el total', async () => {
    const { service, tables } = setup();
    for (let i = 0; i < 3; i++)
      tables.tazapay_collects.push({ collect_id: `col_${i}`, user_id: USER });
    tables.tazapay_collects.push({ collect_id: 'col_otro', user_id: 'otro' });
    const page = await service.listCollects(USER, 2, 0);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
    // Límite acotado a 100.
    expect((await service.listCollects(USER, 5000, 0)).limit).toBe(100);
  });

  it('lector tolerante: con o sin sobre data, enablement y mayúsculas', () => {
    expect(
      parseCollectionAccount({
        id: 'cwa_x',
        type: 'Wallet',
        status: 'DISABLED',
        wallet: { type: 'Solana' },
        requests: [
          { id: 'cwar_x', type: 'enablement', status: 'approval_hold' },
        ],
      }),
    ).toMatchObject({
      collectionAccountId: 'cwa_x',
      type: 'wallet',
      chain: 'solana',
      accountStatus: 'disabled',
      requestStatus: 'approval_hold',
    });
    expect(
      tazapayErrorCode(
        new TazapayApiError('x', 400, false, '{"errors":[{"code":"6133"}]}'),
      ),
    ).toBe('6133');
    expect(collectStatus('collect.detected', {})).toBe('detected');
    expect(collectStatus('collect.weird', {})).toBe('unknown');
  });
});

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SuppliersService } from '../suppliers.service';
import { SwiftSuppliersService } from './swift-suppliers.service';
import { TazapaySwiftEligibilityService } from '../../tazapay/swift/tazapay-swift-eligibility.service';
import { TazapayCorridorService } from '../../tazapay/swift/tazapay-corridor.service';
import { TazapayBeneficiariesService } from '../../tazapay/swift/tazapay-beneficiaries.service';
import { TazapayApiError } from '../../tazapay/tazapay-api.client';
import {
  CN_USD_FIELDS,
  METADATA_CN,
  METADATA_PE,
  SEED_RULES,
  createMemoryDb,
} from '../../tazapay/swift/swift-testing-spec';
import { bankDetailsToSwiftValues } from './swift-bank-details';
import { maskSupplierBankDetails } from '../../../common/masking/mask-bank-details';

/**
 * Alta de proveedores SWIFT (Tazapay) desde SuppliersService.
 *
 * Lo que se protege: que un proveedor SWIFT nunca toque Bridge, que solo lo
 * creen clientes KYB con entity aprobada, que un rechazo de Tazapay no deje
 * filas colgadas y que una falla técnica deje el alta pendiente con la misma
 * idempotency key.
 */

const USER = 'user-1';
const now = () => new Date().toISOString();

function setup(
  opts: {
    accountStatus?: string | null;
    kyb?: boolean;
    enabled?: boolean;
    post?: jest.Mock;
    existingSuppliers?: Array<Record<string, unknown>>;
  } = {},
) {
  const db = createMemoryDb({
    app_settings: [
      {
        key: 'TAZAPAY_SWIFT_BENEFICIARIES_ENABLED',
        value: opts.enabled === false ? 'false' : 'true',
      },
      { key: 'TAZAPAY_SWIFT_ALLOWED_CURRENCIES', value: '' },
    ],
    provider_accounts:
      opts.accountStatus === null
        ? []
        : [
            {
              user_id: USER,
              provider: 'tazapay',
              external_id: 'ent_1',
              status: opts.accountStatus ?? 'approved',
            },
          ],
    provider_onboarding_submissions: [
      {
        user_id: USER,
        provider: 'tazapay',
        external_id: 'ent_1',
        kyb_application_id: opts.kyb === false ? null : 'kyb-1',
      },
    ],
    tazapay_corridor_rules: SEED_RULES,
    tazapay_corridor_cache: [
      {
        country: 'CN',
        payout_type: 'swift',
        response: METADATA_CN,
        fetched_at: now(),
      },
      {
        country: 'PE',
        payout_type: 'swift',
        response: METADATA_PE,
        fetched_at: now(),
      },
    ],
    suppliers: opts.existingSuppliers ?? [],
    tazapay_beneficiaries: [],
    audit_logs: [],
    notifications: [],
  });

  const post =
    opts.post ??
    jest.fn(async () => ({
      status: 'success',
      data: { id: 'bnf_123', destination: 'bnk_456' },
    }));
  const client = {
    post,
    put: jest.fn(),
    get: jest.fn(),
    isConfigured: true,
  } as any;

  const eligibility = new TazapaySwiftEligibilityService(db.client);
  const corridors = new TazapayCorridorService(db.client, client, eligibility);
  const beneficiaries = new TazapayBeneficiariesService(client);
  const notifications = { sendNotification: jest.fn() } as any;
  const swift = new SwiftSuppliersService(
    db.client,
    eligibility,
    corridors,
    beneficiaries,
    notifications,
  );

  const bridge = new Proxy(
    {},
    {
      get: (_t, prop) => () => {
        throw new Error(`Bridge no debe usarse para SWIFT (${String(prop)})`);
      },
    },
  ) as any;
  const service = new SuppliersService(
    db.client,
    bridge,
    {} as any,
    notifications,
    swift,
  );
  return { service, swift, db, post, client, notifications };
}

const cnDto = (overrides: Record<string, unknown> = {}) =>
  ({
    name: 'Shenzhen Hongda Trading Co., Ltd.',
    currency: 'usd',
    payment_rail: 'swift',
    contact_email: 'Finance@Hongda.cn',
    bank_country: 'CN',
    beneficiary_type: 'business',
    swift_fields: { ...CN_USD_FIELDS },
    ...overrides,
  }) as any;

describe('SuppliersService.create con payment_rail = swift', () => {
  it('crea el proveedor y el beneficiario en Tazapay sin pasar por Bridge', async () => {
    const { service, db, post } = setup();
    const result: any = await service.create(USER, cnDto());

    expect(result).toMatchObject({
      payment_rail: 'swift',
      currency: 'usd',
      swift_status: 'active',
    });
    expect(result.bridge_external_account_id).toBeNull();

    const [supplier] = db.tables.suppliers;
    expect(supplier.contact_email).toBe('finance@hongda.cn');
    expect(supplier.bank_details).toMatchObject({
      provider: 'tazapay',
      bank_country: 'CN',
      swift_code: 'CMBCCNBS',
      account_number: '7550123456789012',
      phone: { calling_code: '86', number: '13800138000' },
      beneficiary_address: { line1: 'No. 88 Shennan Road', city: 'Shenzhen' },
    });
    // La dirección NO va en `address` (constraint de formato Bridge).
    expect(supplier.bank_details.address).toBeUndefined();

    const [row] = db.tables.tazapay_beneficiaries;
    expect(row).toMatchObject({
      status: 'active',
      tazapay_beneficiary_id: 'bnf_123',
      destination_id: 'bnk_456',
      country: 'CN',
      currency: 'USD',
      account_last_4: '9012',
      idempotency_key: `guira-bnf-${supplier.id}`,
    });
    expect(JSON.stringify(row.request_payload)).not.toContain(
      '7550123456789012',
    );

    const [path, body, key] = post.mock.calls[0];
    expect(path).toBe('/v3/beneficiary');
    expect(key).toBe(`guira-bnf-${supplier.id}`);
    expect(body).toMatchObject({
      name: 'Shenzhen Hongda Trading Co., Ltd.',
      type: 'business',
      phone: { calling_code: '86', number: '13800138000' },
      address: {
        line1: 'No. 88 Shennan Road',
        city: 'Shenzhen',
        country: 'CN',
      },
      destination_details: {
        type: 'bank',
        bank: {
          account_holder_name: 'Shenzhen Hongda Trading Co., Ltd.',
          account_number: '7550123456789012',
          bank_name: 'China Merchants Bank',
          country: 'CN',
          currency: 'USD',
          transfer_type: 'swift',
          bank_codes: { swift_code: 'CMBCCNBS' },
        },
      },
    });
    expect(body.metadata).toEqual({
      guira_user_id: USER,
      guira_supplier_id: supplier.id,
    });
    expect(db.tables.audit_logs.map((a) => a.action)).toEqual([
      'CREATE_SUPPLIER',
    ]);
  });

  it.each([
    ['entity pendiente', { accountStatus: 'submitted' }, 'ENTITY_PENDING'],
    ['sin entity', { accountStatus: null }, 'ENTITY_MISSING'],
    ['cliente KYC', { kyb: false }, 'NOT_KYB'],
    ['interruptor apagado', { enabled: false }, 'FEATURE_DISABLED'],
  ])('rechaza con 403 si %s', async (_label, opts, code) => {
    const { service, db, post } = setup(opts as any);
    const err = await service.create(USER, cnDto()).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code });
    expect(post).not.toHaveBeenCalled();
    expect(db.tables.suppliers).toHaveLength(0);
  });

  it('valida contra el esquema antes de tocar la DB o Tazapay', async () => {
    const { service, db, post } = setup();
    const fields: Record<string, string> = { ...CN_USD_FIELDS };
    delete fields['phone.number'];
    const err = await service
      .create(USER, cnDto({ swift_fields: fields }))
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'SWIFT_FIELDS_INVALID' });
    expect(post).not.toHaveBeenCalled();
    expect(db.tables.suppliers).toHaveLength(0);
  });

  it('un rechazo de validación de Tazapay borra las filas e invalida la caché si faltan campos', async () => {
    const providerMessage = JSON.stringify({
      status: 'error',
      errors: [
        {
          code: 20361,
          message:
            'Please provide the missing required beneficiary fields: address.state',
        },
      ],
    });
    const post = jest.fn(async () => {
      throw new TazapayApiError('400', 400, false, providerMessage);
    });
    const { service, db } = setup({ post });
    const err = await service.create(USER, cnDto()).catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().message).toContain('address.state');
    expect(db.tables.suppliers).toHaveLength(0);
    expect(db.tables.tazapay_beneficiaries).toHaveLength(0);
    expect(
      db.tables.tazapay_corridor_cache.find((c) => c.country === 'CN'),
    ).toBeUndefined();
    expect(db.tables.audit_logs.map((a) => a.action)).toEqual([
      'SWIFT_BENEFICIARY_REJECTED',
    ]);
  });

  it('una falla técnica deja el alta pendiente y el worker la completa con la misma key', async () => {
    const post = jest
      .fn()
      .mockRejectedValueOnce(
        new TazapayApiError('sin respuesta', null, true, null),
      )
      .mockResolvedValueOnce({
        status: 'success',
        data: { id: 'bnf_late', destination: 'bnk_late' },
      });
    const { service, swift, db } = setup({ post });

    const result: any = await service.create(USER, cnDto());
    expect(result.swift_status).toBe('pending');
    const [row] = db.tables.tazapay_beneficiaries;
    expect(row.status).toBe('pending');

    // El worker no toca altas de menos de 2 minutos.
    row.updated_at = new Date(Date.now() - 5 * 60_000).toISOString();
    await swift.retryPending();

    expect(row).toMatchObject({
      status: 'active',
      tazapay_beneficiary_id: 'bnf_late',
      attempt_count: 2,
    });
    expect(post.mock.calls[0][2]).toBe(post.mock.calls[1][2]);
    // El body rearmado desde bank_details es el mismo que el original.
    expect(post.mock.calls[1][1]).toEqual(post.mock.calls[0][1]);
  });

  it('pasadas 23 h sin respuesta, el alta falla, el proveedor se desactiva y se avisa', async () => {
    const post = jest.fn(async () => {
      throw new TazapayApiError('sin respuesta', null, true, null);
    });
    const { service, swift, db, notifications } = setup({ post });
    await service.create(USER, cnDto());
    const [row] = db.tables.tazapay_beneficiaries;
    row.created_at = new Date(Date.now() - 24 * 3600_000).toISOString();
    row.updated_at = new Date(Date.now() - 10 * 60_000).toISOString();

    await swift.retryPending();

    expect(row.status).toBe('failed');
    expect(db.tables.suppliers[0].is_active).toBe(false);
    expect(notifications.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('un mismo contacto puede tener SWIFT en CN/USD y PE/PEN, pero no dos CN/USD', async () => {
    const { service } = setup();
    await service.create(USER, cnDto());
    await expect(
      service.create(
        USER,
        cnDto({
          currency: 'pen',
          bank_country: 'PE',
          swift_fields: {
            'bank.account_holder_name': 'Textiles Andinos S.A.C.',
            'bank.account_number': '1932456789012',
            'bank.bank_name': 'Banco de Credito del Peru',
            'bank_codes.swift_code': 'BCPLPEPL',
          },
        }),
      ),
    ).resolves.toMatchObject({ swift_status: 'active' });

    await expect(service.create(USER, cnDto())).rejects.toThrow(
      /ya tiene una cuenta SWIFT/,
    );

    const dup = await service.getExistingRailsForEmail(
      USER,
      'finance@hongda.cn',
    );
    expect(dup.usedRails).toEqual([]);
    expect(dup.usedSwift).toEqual(
      expect.arrayContaining([
        { country: 'CN', currency: 'USD' },
        { country: 'PE', currency: 'PEN' },
      ]),
    );
  });
});

describe('Proveedor SWIFT: edición, baja y pagos', () => {
  async function created() {
    const ctx = setup();
    const supplier: any = await ctx.service.create(USER, cnDto());
    return { ...ctx, supplier };
  }

  it('no permite cambiar datos bancarios', async () => {
    const { service, supplier, client } = await created();
    await expect(
      service.update(supplier.id, USER, {
        swift_fields: { 'bank.account_number': '999999' },
      } as any),
    ).rejects.toThrow(/crea un proveedor nuevo/);
    await expect(
      service.update(supplier.id, USER, { account_number: '999999' } as any),
    ).rejects.toThrow(/crea un proveedor nuevo/);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('sincroniza nombre y dirección con Tazapay', async () => {
    const { service, supplier, client, db } = await created();
    await service.update(supplier.id, USER, {
      name: 'Hongda Trading',
      swift_fields: { 'address.city': 'Guangzhou' },
    } as any);

    expect(client.put).toHaveBeenCalledWith(
      '/v3/beneficiary/bnf_123',
      expect.objectContaining({
        name: 'Hongda Trading',
        address: expect.objectContaining({
          city: 'Guangzhou',
          line1: 'No. 88 Shennan Road',
        }),
      }),
    );
    const row = db.tables.suppliers[0];
    expect(row.name).toBe('Hongda Trading');
    expect(row.bank_details.beneficiary_address.city).toBe('Guangzhou');
    expect(row.bank_details.account_number).toBe('7550123456789012');
  });

  it('las notas se editan sin llamar a Tazapay', async () => {
    const { service, supplier, client } = await created();
    await service.update(supplier.id, USER, {
      notes: 'Proveedor de textiles',
    } as any);
    expect(client.put).not.toHaveBeenCalled();
  });

  it('la baja desactiva el proveedor y el beneficiario solo en Guira', async () => {
    const { service, supplier, db } = await created();
    db.tables.payment_orders = [];
    db.tables.payout_requests = [];
    await service.remove(supplier.id, USER);
    expect(db.tables.suppliers[0].is_active).toBe(false);
    expect(db.tables.tazapay_beneficiaries[0].status).toBe('inactive');
  });

  it('un proveedor SWIFT no se puede usar para pagar todavía', async () => {
    const { service } = setup();
    expect(() =>
      service.assertUsableForPayment({ payment_rail: 'swift' }),
    ).toThrow(/SWIFT todavía no están disponibles/);
    expect(() =>
      service.assertUsableForPayment({ payment_rail: 'ach' }),
    ).not.toThrow();
  });

  it('la lista del cliente trae el estado del alta', async () => {
    const { service } = await created();
    const [listed]: any[] = await service.findAll(USER);
    expect(listed.swift_status).toBe('active');
    expect(listed.tazapay_beneficiary_id).toBeUndefined();
  });
});

describe('swift bank_details', () => {
  it('la conversión ida y vuelta conserva los campos', () => {
    const values = {
      'bank.account_holder_name': 'X',
      'bank.account_number': '123456',
      'bank_codes.swift_code': 'CMBCCNBS',
      'bank_codes.cnaps': '308584000013',
      'address.line1': 'L1',
      'phone.number': '13800138000',
      email: 'a@b.cn',
      tax_id: '91440300',
    };
    const { swiftValuesToBankDetails } = jest.requireActual(
      './swift-bank-details',
    );
    const details = swiftValuesToBankDetails(values, {
      bank_country: 'CN',
      beneficiary_type: 'business',
    });
    expect(bankDetailsToSwiftValues(details)).toEqual(values);
  });

  it('el acceso vinculado ve la cuenta y el IBAN enmascarados', () => {
    const masked = maskSupplierBankDetails({
      bank_details: {
        account_number: '7550123456789012',
        iban: 'DE89370400440532013000',
        swift_code: 'CMBCCNBS',
      },
    });
    expect(masked.bank_details.account_number).not.toContain('75501234');
    expect(masked.bank_details.iban).not.toContain('37040044');
    expect(masked.bank_details.swift_code).toBe('CMBCCNBS');
  });
});

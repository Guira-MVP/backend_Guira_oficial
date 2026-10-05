import { TazapayApiError } from '../tazapay-api.client';
import { TazapayCorridorService } from './tazapay-corridor.service';
import { TazapaySwiftEligibilityService } from './tazapay-swift-eligibility.service';
import {
  CN_USD_FIELDS,
  METADATA_CN,
  METADATA_PE,
  SEED_RULES,
  createMemoryDb,
} from './swift-testing-spec';

/**
 * Esquema del formulario SWIFT armado con la metadata real de Tazapay y las
 * reglas de Guira, y la validación del alta en el backend.
 */

function setup(
  opts: {
    metadata?: Record<string, unknown>;
    getImpl?: (path: string) => Promise<unknown>;
    allowed?: string;
    cache?: Array<Record<string, unknown>>;
  } = {},
) {
  const db = createMemoryDb({
    tazapay_corridor_rules: SEED_RULES,
    tazapay_corridor_cache: opts.cache ?? [],
    app_settings: [
      { key: 'TAZAPAY_SWIFT_ALLOWED_CURRENCIES', value: opts.allowed ?? '' },
    ],
  });
  const get = jest.fn(
    opts.getImpl ??
      (async (path: string) =>
        opts.metadata ??
        (path.includes('country=PE') ? METADATA_PE : METADATA_CN)),
  );
  const client = { get, isConfigured: true } as any;
  const eligibility = new TazapaySwiftEligibilityService(db.client);
  const service = new TazapayCorridorService(db.client, client, eligibility);
  return { service, get, db };
}

async function schemaFor(
  service: TazapayCorridorService,
  country: string,
  currency: string,
  type: 'individual' | 'business' = 'business',
) {
  const schema = await service.getFormSchema(country, currency, type);
  if (!schema.available) throw new Error(`no disponible: ${schema.reason}`);
  return schema;
}

describe('TazapayCorridorService.getFormSchema', () => {
  it('CN/USD: pide lo que exige Tazapay más el teléfono de la regla china', async () => {
    const { service } = setup();
    const schema = await schemaFor(service, 'cn', 'usd');

    const required = schema.fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(
      expect.arrayContaining([
        'bank.account_holder_name',
        'bank.account_number',
        'bank.bank_name',
        'bank_codes.swift_code',
        'phone.calling_code',
        'phone.number',
      ]),
    );
    // La dirección viene como recomendada, no obligatoria.
    const line1 = schema.fields.find((f) => f.key === 'address.line1');
    expect(line1).toMatchObject({ required: false, recommended: true });
    // El patrón del móvil chino reemplaza al genérico.
    expect(schema.fields.find((f) => f.key === 'phone.number')?.pattern).toBe(
      '^1[3-9][0-9]{9}$',
    );
    expect(schema.fields.find((f) => f.key === 'name_local')).toMatchObject({
      recommended: true,
      required: false,
    });
    // Las capacidades salen de la red cross_border_wire si el nivel superior está vacío.
    expect(schema.corridor.network).toBe('cross_border_wire');
    expect(schema.notices).toContain(
      'China exige el teléfono móvil del beneficiario.',
    );
  });

  it('pinta los grupos en orden fijo: titular → cuenta → banco → dirección → extra', async () => {
    const { service } = setup();
    const schema = await schemaFor(service, 'CN', 'USD');
    const groups = schema.fields.map((f) => f.group);
    const order = ['holder', 'account', 'bank', 'address', 'extra'];
    const indexes = groups.map((g) => order.indexOf(g));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it('PE/PEN no lleva reglas extra ni teléfono obligatorio', async () => {
    const { service } = setup();
    const schema = await schemaFor(service, 'PE', 'PEN');
    expect(schema.fields.find((f) => f.key === 'phone.number')).toBeUndefined();
    expect(schema.notices).toEqual([]);
  });

  it('ignora los corredores local de la misma moneda', async () => {
    const { service } = setup();
    const result = await service.listCurrencies('PE');
    expect(result.currencies.map((c) => c.currency)).toEqual(['USD', 'PEN']);
  });

  it('un corredor que no existe responde no disponible', async () => {
    const { service } = setup();
    const schema = await service.getFormSchema('CN', 'CNY', 'business');
    expect(schema).toMatchObject({
      available: false,
      reason: 'CORRIDOR_NOT_AVAILABLE',
    });
  });

  it('respeta TAZAPAY_SWIFT_ALLOWED_CURRENCIES', async () => {
    const { service } = setup({ allowed: 'USD' });
    expect(
      (await service.listCurrencies('PE')).currencies.map((c) => c.currency),
    ).toEqual(['USD']);
    expect(await service.getFormSchema('PE', 'PEN', 'business')).toMatchObject({
      available: false,
      reason: 'CURRENCY_NOT_ALLOWED',
    });
  });

  it('si Tazapay publica modos sin B2x, el corredor no sirve para empresas', async () => {
    const metadata = JSON.parse(JSON.stringify(METADATA_CN));
    metadata.data.payout_methods[0].supported_modes = ['C2C'];
    const { service } = setup({ metadata });
    expect(await service.getFormSchema('CN', 'USD', 'business')).toMatchObject({
      available: false,
      reason: 'MODE_NOT_SUPPORTED',
    });
  });

  it('una clave que no está en el diccionario se muestra como texto genérico', async () => {
    const metadata = JSON.parse(JSON.stringify(METADATA_CN));
    metadata.data.payout_methods[0].required_beneficiary_fields = [
      'purpose_reference',
    ];
    const { service } = setup({ metadata });
    const schema = await schemaFor(service, 'CN', 'USD');
    expect(
      schema.fields.find((f) => f.key === 'purpose_reference'),
    ).toMatchObject({
      known: false,
      required: true,
      control: 'text',
      label: 'Purpose reference',
    });
  });

  it('si el corredor menciona el IBAN, cuenta e IBAN quedan como "uno de dos"', async () => {
    const metadata = JSON.parse(JSON.stringify(METADATA_CN));
    metadata.data.payout_methods[0].country = 'DE';
    metadata.data.payout_methods[0].currency = 'EUR';
    metadata.data.payout_methods[0].required_bank_fields = [
      'account_holder_name',
      'bank_name',
      'iban',
    ];
    const { service } = setup({ metadata });
    const schema = await schemaFor(service, 'DE', 'EUR');
    const acc = schema.fields.find((f) => f.key === 'bank.account_number');
    const iban = schema.fields.find((f) => f.key === 'bank.iban');
    expect(acc).toMatchObject({
      required: false,
      oneOfGroup: 'account_identifier',
    });
    expect(iban).toMatchObject({
      required: false,
      oneOfGroup: 'account_identifier',
    });
  });
});

describe('TazapayCorridorService caché', () => {
  it('guarda la respuesta y no vuelve a consultar dentro de las 24 h', async () => {
    const { service, get, db } = setup();
    await service.getFormSchema('CN', 'USD', 'business');
    await service.getFormSchema('CN', 'USD', 'business');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe(
      '/v3/metadata/payout/bank?country=CN&payout_type=swift',
    );
    expect(db.tables.tazapay_corridor_cache).toHaveLength(1);
  });

  it('con Tazapay caído usa la copia vencida', async () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    const { service } = setup({
      cache: [
        {
          country: 'CN',
          payout_type: 'swift',
          response: METADATA_CN,
          fetched_at: old,
        },
      ],
      getImpl: async () => {
        throw new TazapayApiError('timeout', null, true, null);
      },
    });
    const schema = await service.getFormSchema('CN', 'USD', 'business');
    expect(schema).toMatchObject({ available: true, stale: true });
  });

  it('con Tazapay caído y sin copia, el corredor no está disponible', async () => {
    const { service } = setup({
      getImpl: async () => {
        throw new TazapayApiError('timeout', null, true, null);
      },
    });
    expect(await service.getFormSchema('CN', 'USD', 'business')).toMatchObject({
      available: false,
      reason: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('un 4xx de Tazapay se trata como país sin corredores', async () => {
    const { service } = setup({
      getImpl: async () => {
        throw new TazapayApiError('bad country', 400, false, null);
      },
    });
    expect(await service.listCurrencies('XX')).toMatchObject({
      available: false,
      currencies: [],
    });
  });
});

describe('TazapayCorridorService.validateAgainstSchema', () => {
  it('normaliza los valores (espacios, mayúsculas) y acepta un alta china válida', async () => {
    const { service } = setup();
    const schema = await schemaFor(service, 'CN', 'USD');
    const { values, errors } = service.validateAgainstSchema(
      schema,
      CN_USD_FIELDS,
    );
    expect(errors).toEqual([]);
    expect(values['bank.account_number']).toBe('7550123456789012');
    expect(values['bank_codes.swift_code']).toBe('CMBCCNBS');
  });

  it('exige el teléfono en China y valida su formato', async () => {
    const { service } = setup();
    const schema = await schemaFor(service, 'CN', 'USD');
    const withoutPhone: Record<string, string> = { ...CN_USD_FIELDS };
    delete withoutPhone['phone.number'];
    expect(
      service
        .validateAgainstSchema(schema, withoutPhone)
        .errors.map((e) => e.field),
    ).toContain('phone.number');
    const bad = { ...CN_USD_FIELDS, 'phone.number': '5551234' };
    expect(service.validateAgainstSchema(schema, bad).errors[0].field).toBe(
      'phone.number',
    );
  });

  it('rechaza un SWIFT de otro país', async () => {
    const { service } = setup();
    const schema = await schemaFor(service, 'CN', 'USD');
    const { errors } = service.validateAgainstSchema(schema, {
      ...CN_USD_FIELDS,
      'bank_codes.swift_code': 'BCPLPEPL',
    });
    expect(errors).toEqual([
      expect.objectContaining({
        field: 'bank_codes.swift_code',
        message: expect.stringContaining('PE'),
      }),
    ]);
  });

  it('rechaza claves que el esquema no ofrece', async () => {
    const { service } = setup();
    const schema = await schemaFor(service, 'PE', 'PEN');
    const { errors } = service.validateAgainstSchema(schema, {
      'bank.account_holder_name': 'Textiles Andinos S.A.C.',
      'bank.account_number': '1932456789012',
      'bank.bank_name': 'Banco de Credito del Peru',
      'bank_codes.swift_code': 'BCPLPEPL',
      'bank.purpose_code': 'X',
    });
    expect(errors).toEqual([
      expect.objectContaining({ field: 'bank.purpose_code' }),
    ]);
  });

  it('aplica la regla de bancos bloqueados (Fassil en BOB)', async () => {
    const metadata = {
      data: {
        payout_methods: [
          {
            ...METADATA_PE.data.payout_methods[1],
            country: 'BO',
            currency: 'BOB',
          },
        ],
      },
    };
    const { service } = setup({ metadata });
    const schema = await schemaFor(service, 'BO', 'BOB');
    const { errors } = service.validateAgainstSchema(schema, {
      'bank.account_holder_name': 'Proveedor SRL',
      'bank.account_number': '1234567890',
      'bank.bank_name': 'Banco Fassil',
      'bank_codes.swift_code': 'BSCBFBO2',
    });
    expect(errors.map((e) => e.message)).toContain(
      'No se pueden enviar pagos a ese banco en esta moneda.',
    );
    expect(schema.notices).toContain('Sin Fassil.');
  });

  it('valida el dígito de control y el país del IBAN', async () => {
    const metadata = JSON.parse(JSON.stringify(METADATA_CN));
    Object.assign(metadata.data.payout_methods[0], {
      country: 'DE',
      currency: 'EUR',
      required_bank_fields: ['account_holder_name', 'bank_name', 'iban'],
    });
    const { service } = setup({ metadata });
    const schema = await schemaFor(service, 'DE', 'EUR');
    const base = {
      'bank.account_holder_name': 'Müller GmbH',
      'bank.bank_name': 'Deutsche Bank',
      'bank_codes.swift_code': 'DEUTDEFF',
    };
    expect(
      service.validateAgainstSchema(schema, {
        ...base,
        'bank.iban': 'DE89 3704 0044 0532 0130 00',
      }).errors,
    ).toEqual([]);
    expect(
      service.validateAgainstSchema(schema, {
        ...base,
        'bank.iban': 'DE89370400440532013001',
      }).errors[0].field,
    ).toBe('bank.iban');
    // Sin cuenta ni IBAN: un solo error del grupo.
    expect(service.validateAgainstSchema(schema, base).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining(' o ') }),
    ]);
  });
});

import {
  buildBusinessEntityDraft,
  computeRoles,
  toTazapayAddress,
  toTazapayPhone,
  TazapayMappingError,
} from './tazapay-business-mapper';
import {
  evaluateIndustry,
  NaicsRule,
  MSB_VERTICAL,
} from './tazapay-eligibility';
import {
  missingBusinessDocuments,
  personDocumentSpec,
} from './tazapay-document-map';
import {
  computeTazapaySignature,
  verifyTazapaySignature,
} from '../tazapay-webhook-signature';

/**
 * Conversión del KYB de Guira a una entity de empresa de Tazapay.
 * Casos del plan (Docuemntacion_nueva_integracion/PLAN_KYB_FORMULARIO_BRIDGE_TAZAPAY.md §5, §7, §8)
 * y política de verticales honestos (TABLA_EQUIVALENCIAS_NAICS_TAZAPAY.md §4).
 */

const business = {
  id: 'biz-1',
  legal_name: 'Andina Logística S.A.',
  entity_type: 'corporation',
  registration_number: '00123456',
  incorporation_date: '2018-03-15',
  tax_id: '1234567019',
  email: 'finanzas@andina.bo',
  phone: '+59171234567',
  website: 'andina.bo',
  business_description: 'Transporte de carga',
  address1: 'Av Arce 1234',
  city: 'La Paz',
  state: 'L',
  postal_code: '0000',
  country: 'BOL',
  source_of_funds: 'sales_of_goods_and_services',
  expected_monthly_payments_usd: '50000',
};

const marta = {
  id: 'dir-1',
  first_name: 'Marta',
  last_name: 'Rojas',
  date_of_birth: '1985-06-01',
  nationality: 'BOL',
  address1: 'Calle 1',
  city: 'La Paz',
  state: 'L',
  country: 'BOL',
  is_director: false,
};
const ana = {
  id: 'ubo-1',
  first_name: 'Ana',
  last_name: 'Quispe',
  date_of_birth: '1980-01-01',
  nationality: 'BOL',
  ownership_percent: 60,
  is_director: true,
  has_control: true,
  address1: 'X',
  city: 'La Paz',
  country: 'BOL',
};
const carlos = {
  id: 'ubo-2',
  first_name: 'Carlos',
  last_name: 'Mamani',
  date_of_birth: '1979-01-01',
  nationality: 'BOL',
  ownership_percent: 30,
  is_director: true,
  address1: 'X',
  city: 'La Paz',
  country: 'BOL',
};

describe('Tazapay — entity de empresa', () => {
  it('ejemplo Andina Logística: tipo, direcciones, teléfono y roles', () => {
    const draft = buildBusinessEntityDraft({
      userId: 'user-1',
      business,
      directors: [marta],
      ubos: [ana, carlos],
      vertical:
        'Professional Services - Motor Freight Carriers and Trucking - Local and Long Distance, Moving and Storage Companies, and Local Delivery Services',
    });
    expect(draft.type).toBe('company');
    expect(draft.registration_address).toEqual({
      line1: 'Av Arce 1234',
      city: 'La Paz',
      state: 'La Paz',
      country: 'BO',
      postal_code: '0000',
    });
    expect(draft.operating_address).toEqual(draft.registration_address);
    expect(draft.flags.is_operating_address_same_as_registration_address).toBe(
      true,
    );
    expect(draft.flags.is_shareholding_doc_same_as_registration_doc).toBe(
      false,
    );
    expect(draft.tax_id_type).toBe('others');
    expect(draft.phone).toEqual({ calling_code: '+591', number: '71234567' });
    expect(draft.website).toBe('https://andina.bo');
    expect(draft.purpose_of_use).toEqual(['collect', 'payout']);
    expect(draft.relationship).toBe('customer');
    // Sin tildes: Tazapay solo admite [a-zA-Z0-9 &,.-] en el nombre.
    expect(draft.name).toBe('Andina Logistica S.A.');
    expect(draft).not.toHaveProperty('transaction_profile');

    const [rMarta, rAna, rCarlos] = draft.representatives;
    expect(rMarta.roles).toEqual([
      'authorised_representative',
      'authorised_signatory',
    ]);
    expect(rMarta.ownership_percentage).toBe(0);
    expect(rAna.roles.sort()).toEqual([
      'beneficial_owner',
      'director',
      'shareholder',
    ]);
    expect(rCarlos.roles.sort()).toEqual([
      'beneficial_owner',
      'director',
      'shareholder',
    ]);
  });

  it('S.R.L. → company (nunca limited_liability_partnership); unipersonal → sole_proprietorship con casilla', () => {
    const srl = buildBusinessEntityDraft({
      userId: 'u',
      business: { ...business, entity_type: 'llc' },
      directors: [marta],
      ubos: [],
      vertical: 'v',
    });
    expect(srl.type).toBe('company');
    const uni = buildBusinessEntityDraft({
      userId: 'u',
      business: { ...business, entity_type: 'sole_prop' },
      directors: [marta],
      ubos: [],
      vertical: 'v',
    });
    expect(uni.type).toBe('sole_proprietorship');
    expect(uni.flags.is_shareholding_doc_same_as_registration_doc).toBe(true);
  });

  it('exige matrícula y nacionalidad', () => {
    expect(() =>
      buildBusinessEntityDraft({
        userId: 'u',
        business: { ...business, registration_number: null },
        directors: [marta],
        ubos: [],
        vertical: 'v',
      }),
    ).toThrow(TazapayMappingError);
    expect(() =>
      buildBusinessEntityDraft({
        userId: 'u',
        business,
        directors: [
          {
            ...marta,
            nationality: null,
            country: null,
            country_of_residence: null,
          },
        ],
        ubos: [],
        vertical: 'v',
      }),
    ).toThrow(/nacionalidad/);
  });

  it('representante que también es socio se fusiona con la unión de roles', () => {
    const draft = buildBusinessEntityDraft({
      userId: 'u',
      business,
      directors: [marta],
      ubos: [
        {
          ...ana,
          first_name: 'Marta',
          director_id: 'dir-1',
          ownership_percent: 100,
        },
      ],
      vertical: 'v',
    });
    expect(draft.representatives).toHaveLength(1);
    expect(draft.representatives[0].roles.sort()).toEqual(
      [
        'authorised_representative',
        'authorised_signatory',
        'beneficial_owner',
        'shareholder',
      ].sort(),
    );
    expect(draft.representatives[0].ownership_percentage).toBe(100);
  });

  it('roles: socio < 25%, persona con control sin cargo de director, director', () => {
    expect(
      computeRoles({
        isLegalRepresentative: false,
        ownershipPercent: 10,
        isDirector: false,
        hasControl: false,
      }),
    ).toEqual(['shareholder']);
    expect(
      computeRoles({
        isLegalRepresentative: false,
        ownershipPercent: 0,
        isDirector: false,
        hasControl: true,
      }),
    ).toEqual(['other']);
    expect(
      computeRoles({
        isLegalRepresentative: false,
        ownershipPercent: 30,
        isDirector: false,
        hasControl: true,
      }).sort(),
    ).toEqual(['beneficial_owner', 'other', 'shareholder']);
    expect(
      computeRoles({
        isLegalRepresentative: true,
        ownershipPercent: 0,
        isDirector: true,
        hasControl: true,
      }).sort(),
    ).toEqual([
      'authorised_representative',
      'authorised_signatory',
      'director',
    ]);
  });

  it('dirección: USA conserva el ZIP; Bolivia lleva el marcador 0000', () => {
    expect(
      toTazapayAddress({
        address1: 'a',
        city: 'Miami',
        state: 'FL',
        postal_code: '33101',
        country: 'USA',
      }),
    ).toMatchObject({
      country: 'US',
      postal_code: '33101',
    });
    expect(
      toTazapayAddress({
        address1: 'a',
        city: 'La Paz',
        country: 'BOL',
      })?.postal_code,
    ).toBe('0000');
    expect(
      toTazapayAddress({
        address1: 'Calle <1> = {2}',
        city: 'La Paz',
        country: 'BOL',
      })?.line1,
    ).toBe('Calle 1 2');
    expect(toTazapayPhone('no-es-telefono')).toBeUndefined();
  });
});

describe('Tazapay — elegibilidad por industria', () => {
  const rules: NaicsRule[] = [
    {
      naics_prefix: '484',
      vertical: 'Trucking',
      quality: 'exacta',
      requires_compliance: false,
      note: null,
    },
    {
      naics_prefix: '31',
      vertical: null,
      quality: 'sin_vertical',
      requires_compliance: false,
      note: 'Fabricación sin vertical',
    },
    {
      naics_prefix: '4453',
      vertical: null,
      quality: 'sin_vertical',
      requires_compliance: true,
      note: 'Licorería',
    },
    {
      naics_prefix: '42',
      vertical: 'Wholesale',
      quality: 'generica',
      requires_compliance: false,
      note: null,
    },
    {
      naics_prefix: '4247',
      vertical: 'Wholesale',
      quality: 'confirmar_tazapay',
      requires_compliance: true,
      note: 'Combustibles',
    },
  ];

  it('vertical exacto', () => {
    expect(
      evaluateIndustry({ industryCodes: ['484110'], rules }),
    ).toMatchObject({ quality: 'exacta', vertical: 'Trucking' });
  });
  it('manufactura y licorería quedan sin vertical', () => {
    expect(evaluateIndustry({ industryCodes: ['311111'], rules }).quality).toBe(
      'sin_vertical',
    );
    expect(evaluateIndustry({ industryCodes: ['445320'], rules }).quality).toBe(
      'sin_vertical',
    );
  });
  it('regla de la peor calidad: comercio + fabricación = sin vertical', () => {
    const r = evaluateIndustry({ industryCodes: ['423110', '311111'], rules });
    expect(r.quality).toBe('sin_vertical');
    expect(r.vertical).toBeNull();
  });
  it('combustibles: confirmar con Tazapay', () => {
    expect(evaluateIndustry({ industryCodes: ['424710'], rules }).quality).toBe(
      'confirmar_tazapay',
    );
  });
  it('servicios de dinero → vertical MSB con compliance; apuestas → no elegible', () => {
    const msb = evaluateIndustry({
      industryCodes: ['484110'],
      rules,
      conductsMoneyServices: true,
    });
    expect(msb).toMatchObject({
      vertical: MSB_VERTICAL,
      requiresCompliance: true,
      quality: 'exacta',
    });
    expect(
      evaluateIndustry({
        industryCodes: ['484110'],
        rules,
        highRiskActivities: ['gambling'],
      }).quality,
    ).toBe('no_elegible');
  });
  it('sin industrias declaradas: sin vertical', () => {
    expect(evaluateIndustry({ industryCodes: [], rules }).quality).toBe(
      'sin_vertical',
    );
  });
});

describe('Tazapay — documentos', () => {
  it('faltantes obligatorios del paso Documents', () => {
    expect(
      missingBusinessDocuments({
        entityType: 'llc',
        available: new Set(['incorporation_certificate', 'proof_of_address']),
        ownershipInIncorporationDoc: true,
        shareholdingSameAsRegistration: false,
      }),
    ).toEqual(['Matrícula de comercio (Business registration proof)']);
    expect(
      missingBusinessDocuments({
        entityType: 'corporation',
        available: new Set([
          'business_registration',
          'incorporation_certificate',
          'proof_of_address',
        ]),
        ownershipInIncorporationDoc: false,
        shareholdingSameAsRegistration: false,
      }),
    ).toEqual(['Estructura accionaria (Business shareholding structure)']);
  });
  it('documentos de persona: la selfie no se envía; licencia → driving_license', () => {
    expect(personDocumentSpec('selfie')).toBeNull();
    expect(personDocumentSpec('drivers_license_back')).toMatchObject({
      sub_type: 'driving_license',
      tag: 'identityProofTypeBackDoc',
    });
    expect(
      personDocumentSpec('proof_of_address', 'lease_agreement')?.description,
    ).toBe('Lease agreement');
  });
});

describe('Tazapay — firma de webhooks', () => {
  const secret = 'YKzhhJM4gd8s5MS1LVvWbqSyJqLPvr7j';
  const raw = JSON.stringify({
    id: 'evt_1',
    type: 'entity.approval_succeeded',
    created_at: '2025-03-11T12:25:08.284979602Z',
    data: { id: 'ent_1' },
  });
  const signature = computeTazapaySignature(
    secret,
    'evt_1',
    raw,
    '2025-03-11T12:25:08.284979602Z',
  );

  it('acepta la firma correcta', () => {
    expect(
      verifyTazapaySignature({
        secret,
        rawBody: raw,
        signatureHeader: signature,
      }),
    ).toBe(true);
  });
  it('rechaza firma alterada, secreto vacío o body modificado', () => {
    expect(
      verifyTazapaySignature({
        secret,
        rawBody: raw,
        signatureHeader: 'x' + signature.slice(1),
      }),
    ).toBe(false);
    expect(
      verifyTazapaySignature({
        secret: '',
        rawBody: raw,
        signatureHeader: signature,
      }),
    ).toBe(false);
    expect(
      verifyTazapaySignature({
        secret,
        rawBody: raw.replace('ent_1', 'ent_2'),
        signatureHeader: signature,
      }),
    ).toBe(false);
  });
});

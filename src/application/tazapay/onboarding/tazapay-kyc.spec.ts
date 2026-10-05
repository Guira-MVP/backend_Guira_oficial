import { TazapayMappingError } from './tazapay-business-mapper';
import {
  buildIndividualEntityDraft,
  missingIndividualData,
} from './tazapay-individual-mapper';
import { TazapayKycOnboardingService } from './tazapay-kyc-onboarding.service';

const PERSON = {
  first_name: 'María José',
  middle_name: null,
  last_name: 'Peñaranda Quispe',
  date_of_birth: '1990-05-15',
  nationality: 'BOL',
  country_of_residence: 'BOL',
  id_type: 'national_id',
  id_number: ' 1234567 ',
  id_expiry_date: null,
  email: 'maria@example.com',
  phone: '+59171234567',
  address1: 'Calle Sucre 123',
  address2: null,
  city: 'La Paz',
  state: 'L',
  postal_code: null,
  country: 'BOL',
  tax_id: null,
  tax_id_type: null,
  source_of_funds: 'salary',
  employment_status: 'employed',
  most_recent_occupation: '151252',
};

describe('Tazapay — entity individual (KYC)', () => {
  it('arma la entity con identidad, dirección, ocupación y origen de fondos', () => {
    const draft = buildIndividualEntityDraft({ userId: 'u-1', person: PERSON });

    // Nombre sin tildes ni ñ (regla de Tazapay para name).
    expect(draft.name).toBe('Maria Jose Penaranda Quispe');
    expect(draft.type).toBe('individual');
    expect(draft.reference_id).toBe('u-1');
    expect(draft.purpose_of_use).toEqual(['collect', 'payout']);
    expect(draft.registration_address).toEqual({
      line1: 'Calle Sucre 123',
      city: 'La Paz',
      state: 'La Paz',
      country: 'BO',
      postal_code: '0000',
    });
    // calling_code sin "+": el dashboard de Tazapay antepone el suyo.
    expect(draft.phone).toEqual({ calling_code: '591', number: '71234567' });
    expect(draft.individual).toEqual({
      national_identification_number: {
        type: 'national_id',
        number: '1234567',
        issuer: { country: 'BO' },
        country_of_citizenship: 'BO',
      },
      date_of_birth: '1990-05-15',
      nationality: 'BO',
      profession: {
        // ISCO-08 2512 Software developers (tabla O*NET → ISCO aprobada).
        isco_code: '2512',
        employment_status: 'employed',
      },
      // `salary` exige empleador y cargo en Tazapay: va como `other`.
      source_of_funds: { primary_source: 'other', description: 'Salary' },
    });
    expect(draft).not.toHaveProperty('tax_id');
  });

  it('salario con empleador y cargo → salary + employment_details', () => {
    const draft = buildIndividualEntityDraft({
      userId: 'u-1',
      person: {
        ...PERSON,
        employer_name: ' Banco Mercantil Santa Cruz S.A. ',
        job_title: 'Analista de sistemas',
      },
    });
    expect(draft.individual.source_of_funds).toEqual({
      primary_source: 'salary',
    });
    expect(draft.individual.employment_details).toEqual({
      employer_name: 'Banco Mercantil Santa Cruz S.A.',
      designation: 'Analista de sistemas',
    });

    // Falta el cargo: sigue como other + Salary, sin employment_details.
    const partial = buildIndividualEntityDraft({
      userId: 'u-1',
      person: { ...PERSON, employer_name: 'Entel S.A.', job_title: '' },
    });
    expect(partial.individual.source_of_funds).toEqual({
      primary_source: 'other',
      description: 'Salary',
    });
    expect(partial.individual).not.toHaveProperty('employment_details');

    // Empleador cargado pero el origen no es salario: no se envía.
    const savings = buildIndividualEntityDraft({
      userId: 'u-1',
      person: {
        ...PERSON,
        source_of_funds: 'savings',
        employer_name: 'Entel S.A.',
        job_title: 'Técnico',
      },
    });
    expect(savings.individual).not.toHaveProperty('employment_details');
  });

  it('licencia → driving_license, vencimiento y NIT como others', () => {
    const draft = buildIndividualEntityDraft({
      userId: 'u-1',
      person: {
        ...PERSON,
        id_type: 'drivers_license',
        id_expiry_date: '2030-01-31',
        tax_id: '1234567012',
        tax_id_type: 'nit',
        source_of_funds: 'savings',
        most_recent_occupation: null,
      },
    });
    expect(draft.individual.national_identification_number).toMatchObject({
      type: 'driving_license',
      expiration: '2030-01-31',
    });
    expect(draft.tax_id).toBe('1234567012');
    expect(draft.tax_id_type).toBe('others');
    expect(draft.individual.source_of_funds).toEqual({
      primary_source: 'savings',
    });
    expect(draft.individual).not.toHaveProperty('profession');
  });

  it('sin datos obligatorios lanza error de mapeo con lo que falta', () => {
    expect(
      missingIndividualData({ ...PERSON, nationality: null, id_type: 'visa' }),
    ).toEqual([
      'Nacionalidad',
      'Tipo de documento de identidad (pasaporte, carnet o licencia)',
    ]);
    expect(() =>
      buildIndividualEntityDraft({
        userId: 'u-1',
        person: { ...PERSON, date_of_birth: null },
      }),
    ).toThrow(TazapayMappingError);
  });

  it('documentos: solo cuentan los del tipo de identidad declarado', () => {
    const service = Object.create(
      TazapayKycOnboardingService.prototype,
    ) as TazapayKycOnboardingService;
    const doc = (
      document_type: string,
      document_subtype: string | null = null,
    ) => ({
      id: document_type,
      document_type,
      document_subtype,
      storage_path: 'x',
      mime_type: 'image/jpeg',
      file_name: null,
      subject_type: 'person',
      subject_id: null,
    });

    // Declara carnet pero solo subió pasaporte: falta la identidad.
    expect(
      service.missingForTazapay({
        userId: 'u-1',
        person: PERSON,
        documents: [doc('passport'), doc('proof_of_address', 'utility_bill')],
      }),
    ).toEqual(['Documento de identidad (frente o página principal)']);

    expect(
      service.missingForTazapay({
        userId: 'u-1',
        person: PERSON,
        documents: [
          doc('national_id_front'),
          doc('national_id_back'),
          doc('selfie'),
        ],
      }),
    ).toEqual(['Comprobante de domicilio']);
  });
});

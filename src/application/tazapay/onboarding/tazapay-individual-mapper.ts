import { toAlpha2 } from '../../../core/utils/country-codes';
import { OCCUPATION_TO_ISCO08 } from '../../../core/utils/occupation-isco';
import {
  TazapayAddress,
  TazapayMappingError,
  TazapayPhone,
  toTazapayAddress,
  toTazapayDate,
  toTazapayEntityName,
  toTazapayPhone,
} from './tazapay-business-mapper';

/**
 * Armado de la entity `individual` de Tazapay a partir del expediente KYC
 * (tabla `people`). Mismas reglas de dirección, código postal y nombre que la
 * entity de empresa, aprendidas en el sandbox (ver tazapay-business-mapper).
 * Campos del objeto `individual`: changelog "Entity Individual Enhancement".
 */

/** Tipo de documento de Guira → national_identification_number.type de Tazapay. */
const ID_TYPE_TO_TAZAPAY: Readonly<Record<string, string>> = {
  passport: 'passport',
  national_id: 'national_id',
  drivers_license: 'driving_license',
};

/**
 * Origen de fondos de Guira (enum de Bridge) → source_of_funds de Tazapay.
 * Cuando no hay un valor que lo describa tal cual se usa `other` con la
 * descripción. `salary` va como `other` + "Salary" salvo que el cliente haya
 * dado empleador y cargo: Tazapay exige employment_details para `salary`
 * (ver buildIndividualEntityDraft).
 */
const SOURCE_OF_FUNDS: Readonly<
  Record<string, { primary_source: string; description?: string }>
> = {
  salary: { primary_source: 'other', description: 'Salary' },
  savings: { primary_source: 'savings' },
  company_funds: { primary_source: 'business_income' },
  investments_loans: {
    primary_source: 'other',
    description: 'Investments or loans',
  },
  government_benefits: {
    primary_source: 'other',
    description: 'Government benefits',
  },
  pension_retirement: { primary_source: 'pension' },
  inheritance: { primary_source: 'inheritance' },
  gifts: { primary_source: 'gift' },
  sale_of_assets_real_estate: { primary_source: 'sale_of_assets' },
  ecommerce_reseller: { primary_source: 'business_income' },
  someone_elses_funds: {
    primary_source: 'other',
    description: "Someone else's funds",
  },
  gambling_proceeds: {
    primary_source: 'other',
    description: 'Gambling proceeds',
  },
};

const INDIVIDUAL_TAX_ID_TYPES = new Set(['ssn', 'itin', 'cpf', 'pan']);

/** Estados de empleo de Guira: mismos valores que el enum de Tazapay. */
const EMPLOYMENT_STATUSES = new Set([
  'employed',
  'self_employed',
  'unemployed',
  'student',
  'retired',
  'homemaker',
]);

export interface TazapayIndividualDetails {
  national_identification_number: {
    type: string;
    number: string;
    issuer?: { country: string };
    expiration?: string;
    country_of_citizenship?: string;
  };
  date_of_birth: string;
  nationality: string;
  profession?: { isco_code: string; employment_status?: string };
  source_of_funds?: { primary_source: string; description?: string };
  employment_details?: { employer_name: string; designation: string };
}

export interface TazapayIndividualEntityDraft {
  name: string;
  type: 'individual';
  email?: string;
  phone?: TazapayPhone;
  registration_address: TazapayAddress;
  tax_id?: string;
  tax_id_type?: string;
  relationship: 'customer';
  purpose_of_use: string[];
  reference_id: string;
  individual: TazapayIndividualDetails;
}

/** Faltantes de datos de la persona para Tazapay (no de documentos). */
export function missingIndividualData(
  person: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  if (!toTazapayEntityName(fullName(person))) missing.push('Nombre');
  if (!toTazapayDate(person.date_of_birth)) missing.push('Fecha de nacimiento');
  if (!toAlpha2(person.nationality as string)) missing.push('Nacionalidad');
  if (!ID_TYPE_TO_TAZAPAY[String(person.id_type ?? '')])
    missing.push(
      'Tipo de documento de identidad (pasaporte, carnet o licencia)',
    );
  if (!String(person.id_number ?? '').trim())
    missing.push('Número de documento de identidad');
  if (!personAddress(person)) missing.push('Dirección completa');
  return missing;
}

function fullName(person: Record<string, unknown>): string {
  return [person.first_name, person.middle_name, person.last_name]
    .filter((p) => typeof p === 'string' && p.trim())
    .join(' ');
}

function personAddress(person: Record<string, unknown>) {
  return toTazapayAddress({
    address1: person.address1,
    address2: person.address2,
    city: person.city,
    state: person.state,
    postal_code: person.postal_code,
    country: person.country,
  });
}

export function buildIndividualEntityDraft(params: {
  userId: string;
  person: Record<string, unknown>;
}): TazapayIndividualEntityDraft {
  const { person } = params;
  const missing = missingIndividualData(person);
  if (missing.length > 0) {
    throw new TazapayMappingError(
      `Faltan datos de la persona para Tazapay: ${missing.join(', ')}.`,
    );
  }

  const nationality = toAlpha2(person.nationality as string) as string;
  const nationalId: TazapayIndividualDetails['national_identification_number'] =
    {
      type: ID_TYPE_TO_TAZAPAY[String(person.id_type)],
      number: String(person.id_number).trim(),
      // Guira no pregunta el país emisor: el documento lo emite el país de
      // la nacionalidad (carnet y pasaporte bolivianos, el caso general).
      issuer: { country: nationality },
      country_of_citizenship: nationality,
    };
  const expiration = toTazapayDate(person.id_expiry_date);
  if (expiration) nationalId.expiration = expiration;

  const individual: TazapayIndividualDetails = {
    national_identification_number: nationalId,
    date_of_birth: toTazapayDate(person.date_of_birth) as string,
    nationality,
  };

  // Tazapay valida la ocupación contra ISCO-08 (un título libre da error
  // 2642): se manda solo isco_code, que basta según su documentación.
  const iscoCode =
    OCCUPATION_TO_ISCO08[String(person.most_recent_occupation ?? '')];
  if (iscoCode) {
    individual.profession = { isco_code: iscoCode };
    const status = String(person.employment_status ?? '');
    if (EMPLOYMENT_STATUSES.has(status))
      individual.profession.employment_status = status;
  }

  const sof = SOURCE_OF_FUNDS[String(person.source_of_funds ?? '')];
  if (sof) individual.source_of_funds = { ...sof };

  // Salario: Tazapay exige employment_details para primary_source = salary.
  // Con empleador y cargo se envía salary; sin ellos (expedientes anteriores
  // al formulario con esos campos) sigue yendo como other + "Salary".
  const employer = String(person.employer_name ?? '')
    .trim()
    .slice(0, 200);
  const jobTitle = String(person.job_title ?? '')
    .trim()
    .slice(0, 100);
  if (person.source_of_funds === 'salary' && employer && jobTitle) {
    individual.source_of_funds = { primary_source: 'salary' };
    individual.employment_details = {
      employer_name: employer,
      designation: jobTitle,
    };
  }

  const draft: TazapayIndividualEntityDraft = {
    name: toTazapayEntityName(fullName(person)),
    type: 'individual',
    registration_address: personAddress(person) as TazapayAddress,
    relationship: 'customer',
    purpose_of_use: ['collect', 'payout'],
    reference_id: params.userId,
    individual,
  };
  if (person.email) draft.email = String(person.email);
  const phone = toTazapayPhone(person.phone);
  if (phone) draft.phone = phone;
  if (person.tax_id && String(person.tax_id).trim()) {
    draft.tax_id = String(person.tax_id).trim();
    // Tazapay valida ssn/itin (EE.UU.), cpf (Brasil) y pan (India); el NIT y
    // el resto van como `others`, que no se valida.
    const type = String(person.tax_id_type ?? '').toLowerCase();
    draft.tax_id_type = INDIVIDUAL_TAX_ID_TYPES.has(type) ? type : 'others';
  }
  return draft;
}

import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { subdivisionName, toAlpha2 } from '../../../core/utils/country-codes';

/**
 * Conversión del expediente KYB de Guira (pensado para Bridge) al formato
 * de una entity de empresa de Tazapay (POST/PUT /v3/entity).
 * Funciones puras: sin base de datos ni red, para poder probarlas con
 * fixtures. Ver Docuemntacion_nueva_integracion/PLAN_KYB_FORMULARIO_BRIDGE_TAZAPAY.md
 * §4 (empresa), §5 (personas y roles) y §7 (tipo societario).
 */

export type TazapayRole =
  | 'director'
  | 'shareholder'
  | 'beneficial_owner'
  | 'authorised_signatory'
  | 'authorised_representative'
  | 'other';

export interface TazapayAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  country: string;
  postal_code?: string;
}

export interface TazapayPhone {
  calling_code: string;
  number: string;
}

export interface TazapayRepresentativeDraft {
  /** Persona de Guira de la que sale (para adjuntarle sus documentos). */
  source: { type: 'director' | 'ubo'; id: string; linkedUboId?: string };
  first_name: string;
  last_name?: string;
  date_of_birth: string;
  nationality: string;
  address?: TazapayAddress;
  phone?: TazapayPhone;
  ownership_percentage: number;
  roles: TazapayRole[];
}

export interface TazapayBusinessEntityDraft {
  name: string;
  type: string;
  email?: string;
  description?: string;
  registration_number?: string;
  registration_date?: string;
  tax_id?: string;
  tax_id_type?: string;
  website?: string;
  vertical?: string;
  phone?: TazapayPhone;
  registration_address: TazapayAddress;
  operating_address: TazapayAddress;
  relationship: 'customer';
  purpose_of_use: string[];
  reference_id: string;
  source_of_wealth?: string;
  transaction_profile?: { monthly_expected_transactions_value: number };
  representatives: TazapayRepresentativeDraft[];
  /** Casillas que solo acepta PUT /v3/entity/{id}. */
  flags: {
    is_operating_address_same_as_registration_address: boolean;
    is_shareholding_doc_same_as_registration_doc: boolean;
  };
}

export class TazapayMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TazapayMappingError';
  }
}

/** Tipo societario de Guira → tipo de entity de Tazapay (plan KYB §7.1). */
export const ENTITY_TYPE_TO_TAZAPAY: Readonly<Record<string, string>> = {
  corporation: 'company',
  llc: 'company', // S.R.L. es sociedad de capital: company, nunca limited_liability_partnership
  partnership: 'partnership',
  sole_prop: 'sole_proprietorship',
  trust: 'trust',
  cooperative: 'other',
  other: 'other',
  non_profit: 'non_profit',
  government_entity: 'government_entity',
};

/** Países sin código postal en el formulario: su marcador ("0000") no se envía. */
const COUNTRIES_WITHOUT_POSTAL_CODE = new Set(['BOL', 'PAN', 'GUY', 'SUR']);

/**
 * Formato de fechas para Tazapay. La doc describe DD-MM-YYYY pero todos sus
 * ejemplos y el objeto entity usan ISO 8601 (YYYY-MM-DD). Pendiente de
 * confirmar en sandbox (plan KYB §11); un único punto de cambio.
 */
export function toTazapayDate(value: unknown): string | undefined {
  if (!value) return undefined;
  const iso = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : undefined;
}

export function toTazapayPhone(raw: unknown): TazapayPhone | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parsed = parsePhoneNumberFromString(raw.trim());
  if (!parsed) return undefined;
  return {
    calling_code: `+${parsed.countryCallingCode}`,
    number: String(parsed.nationalNumber),
  };
}

export function toTazapayAddress(fields: {
  address1: unknown;
  address2?: unknown;
  city: unknown;
  state?: unknown;
  postal_code?: unknown;
  country: unknown;
}): TazapayAddress | undefined {
  const country3 =
    typeof fields.country === 'string' ? fields.country.toUpperCase() : '';
  const country = toAlpha2(country3);
  if (!fields.address1 || !fields.city || !country) return undefined;

  const address: TazapayAddress = {
    line1: String(fields.address1),
    city: String(fields.city),
    country,
  };
  if (fields.address2) address.line2 = String(fields.address2);
  const state = subdivisionName(
    country3.length === 3 ? country3 : undefined,
    fields.state as string | undefined,
  );
  if (state) address.state = state;
  const postal =
    typeof fields.postal_code === 'string' ? fields.postal_code.trim() : '';
  if (
    postal &&
    !(COUNTRIES_WITHOUT_POSTAL_CODE.has(country3) && /^0+$/.test(postal))
  ) {
    address.postal_code = postal;
  }
  return address;
}

/** tax_id_type de Tazapay según el país de registro de la empresa. */
export function businessTaxIdType(countryAlpha3: string): string {
  switch (countryAlpha3.toUpperCase()) {
    case 'USA':
      return 'ein';
    case 'BRA':
      return 'cnpj';
    default:
      return 'others';
  }
}

function humanize(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeWebsite(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const v = value.trim();
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** Roles de Tazapay de una persona (plan KYB §5.2). Nunca se asume un rol no declarado. */
export function computeRoles(input: {
  isLegalRepresentative: boolean;
  ownershipPercent: number;
  isDirector: boolean;
  hasControl: boolean;
  beneficialOwnerThreshold?: number;
}): TazapayRole[] {
  const threshold = input.beneficialOwnerThreshold ?? 25;
  const roles = new Set<TazapayRole>();
  if (input.isLegalRepresentative) {
    roles.add('authorised_representative');
    roles.add('authorised_signatory');
  }
  if (input.ownershipPercent > 0) roles.add('shareholder');
  if (input.ownershipPercent >= threshold) roles.add('beneficial_owner');
  if (input.isDirector) roles.add('director');
  // `other` cubre a quien tiene control y ningún otro rol lo describe.
  if (input.hasControl && !input.isLegalRepresentative && !input.isDirector)
    roles.add('other');
  if (roles.size === 0) roles.add('other');
  return [...roles];
}

function personNationality(person: Record<string, unknown>): string {
  const nationality =
    toAlpha2(person.nationality as string) ??
    toAlpha2(person.country_of_residence as string) ??
    toAlpha2(person.country as string);
  if (!nationality) {
    throw new TazapayMappingError(
      `La persona ${String(person.first_name ?? '')} ${String(person.last_name ?? '')} no tiene nacionalidad: Tazapay la exige para cada representante.`,
    );
  }
  return nationality;
}

function personDob(person: Record<string, unknown>): string {
  const dob = toTazapayDate(person.date_of_birth);
  if (!dob) {
    throw new TazapayMappingError(
      `La persona ${String(person.first_name ?? '')} ${String(person.last_name ?? '')} no tiene fecha de nacimiento: Tazapay la exige.`,
    );
  }
  return dob;
}

export function buildRepresentatives(
  directors: Record<string, unknown>[],
  ubos: Record<string, unknown>[],
): TazapayRepresentativeDraft[] {
  const reps: TazapayRepresentativeDraft[] = [];
  const mergedUboIds = new Set<string>();

  for (const dir of directors) {
    const linkedUbo = ubos.find((u) => u.director_id === dir.id);
    if (linkedUbo) mergedUboIds.add(String(linkedUbo.id));
    const pct = linkedUbo ? Number(linkedUbo.ownership_percent ?? 0) : 0;
    reps.push({
      source: {
        type: 'director',
        id: String(dir.id),
        linkedUboId: linkedUbo ? String(linkedUbo.id) : undefined,
      },
      first_name: String(dir.first_name ?? ''),
      last_name: dir.last_name ? String(dir.last_name) : undefined,
      date_of_birth: personDob(dir),
      nationality: personNationality(dir),
      address: toTazapayAddress(dir as never),
      phone: toTazapayPhone(dir.phone ?? linkedUbo?.phone),
      ownership_percentage: pct,
      roles: computeRoles({
        isLegalRepresentative: true,
        ownershipPercent: pct,
        isDirector: dir.is_director === true,
        hasControl: true,
      }),
    });
  }

  for (const ubo of ubos) {
    if (mergedUboIds.has(String(ubo.id))) continue;
    const pct = Number(ubo.ownership_percent ?? 0);
    reps.push({
      source: { type: 'ubo', id: String(ubo.id) },
      first_name: String(ubo.first_name ?? ''),
      last_name: ubo.last_name ? String(ubo.last_name) : undefined,
      date_of_birth: personDob(ubo),
      nationality: personNationality(ubo),
      address: toTazapayAddress(ubo as never),
      phone: toTazapayPhone(ubo.phone),
      ownership_percentage: pct,
      roles: computeRoles({
        isLegalRepresentative: false,
        ownershipPercent: pct,
        isDirector: ubo.is_director === true,
        hasControl: ubo.has_control === true,
      }),
    });
  }
  return reps;
}

export function buildBusinessEntityDraft(params: {
  userId: string;
  business: Record<string, unknown>;
  directors: Record<string, unknown>[];
  ubos: Record<string, unknown>[];
  vertical: string;
}): TazapayBusinessEntityDraft {
  const { business, userId } = params;

  const type = ENTITY_TYPE_TO_TAZAPAY[String(business.entity_type ?? '')];
  if (!type)
    throw new TazapayMappingError(
      `Tipo societario sin equivalente en Tazapay: ${String(business.entity_type)}`,
    );
  if (!business.registration_number) {
    throw new TazapayMappingError(
      'Falta el número de registro de la empresa (matrícula de comercio): Tazapay lo exige.',
    );
  }

  const registration = toTazapayAddress({
    address1: business.address1,
    address2: business.address2,
    city: business.city,
    state: business.state,
    postal_code: business.postal_code,
    country: business.country,
  });
  if (!registration)
    throw new TazapayMappingError(
      'La dirección registrada de la empresa está incompleta.',
    );

  const physical = business.physical_address1
    ? toTazapayAddress({
        address1: business.physical_address1,
        address2: business.physical_address2,
        city: business.physical_city,
        state: business.physical_state,
        postal_code: business.physical_postal_code,
        country: business.physical_country,
      })
    : undefined;

  const country3 = String(business.country ?? '').toUpperCase();
  const draft: TazapayBusinessEntityDraft = {
    name: String(business.legal_name ?? ''),
    type,
    registration_number: String(business.registration_number),
    registration_address: registration,
    operating_address: physical ?? registration,
    relationship: 'customer',
    purpose_of_use: ['collect', 'payout'],
    reference_id: userId,
    vertical: params.vertical,
    representatives: buildRepresentatives(params.directors, params.ubos),
    flags: {
      is_operating_address_same_as_registration_address: !physical,
      // Unipersonal: la matrícula nombra al único dueño. En el resto solo si
      // el staff verificó que el registro muestra a los socios con su %.
      is_shareholding_doc_same_as_registration_doc:
        business.entity_type === 'sole_prop' ||
        business.shareholding_same_as_registration === true,
    },
  };

  if (business.email) draft.email = String(business.email);
  if (business.business_description)
    draft.description = String(business.business_description);
  const regDate = toTazapayDate(business.incorporation_date);
  if (regDate) draft.registration_date = regDate;
  if (business.tax_id) {
    draft.tax_id = String(business.tax_id);
    draft.tax_id_type = businessTaxIdType(country3);
  }
  const website = normalizeWebsite(business.website);
  if (website) draft.website = website;
  const phone = toTazapayPhone(business.phone);
  if (phone) draft.phone = phone;

  const sof = humanize(business.source_of_funds);
  if (sof) {
    draft.source_of_wealth = business.source_of_funds_description
      ? `${sof}: ${String(business.source_of_funds_description)}`
      : sof;
  }
  const monthlyUsd = Number(business.expected_monthly_payments_usd);
  if (Number.isFinite(monthlyUsd) && monthlyUsd > 0) {
    // Tazapay pide el valor en la unidad mínima de la moneda (centavos de USD).
    draft.transaction_profile = {
      monthly_expected_transactions_value: Math.round(monthlyUsd * 100),
    };
  }
  return draft;
}

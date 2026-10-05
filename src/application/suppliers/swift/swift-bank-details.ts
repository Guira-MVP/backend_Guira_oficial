/**
 * Conversión entre los campos del formulario SWIFT (claves del diccionario de
 * Tazapay: "bank.account_number", "address.city"…) y `suppliers.bank_details`.
 *
 * `bank_details` guarda los datos planos, con los mismos nombres que usan los
 * demás rails cuando existen (account_number, iban, swift_code, bank_name),
 * para que el enmascarado, el PDF y el panel de staff los reconozcan. La
 * dirección va en `beneficiary_address` y NO en `address`: el constraint
 * `suppliers_address_minimum_fields` exige el formato de Bridge
 * (street_line_1) dentro de `address`.
 *
 * La conversión es reversible: el worker de reintentos rearma el body de
 * Tazapay a partir de bank_details.
 */

export interface SwiftBankDetailsMeta {
  bank_country: string;
  beneficiary_type: 'individual' | 'business';
}

/** Claves del diccionario que viven en el primer nivel de bank_details con otro nombre. */
const TOP_LEVEL_RENAMES: Record<string, string> = {
  'bank_codes.swift_code': 'swift_code',
  email: 'beneficiary_email',
};
const RENAMES_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(TOP_LEVEL_RENAMES).map(([k, v]) => [v, k]),
);

const NESTED_PREFIXES: Record<string, string> = {
  address: 'beneficiary_address',
  phone: 'phone',
  bank_codes: 'bank_codes',
};

/** Claves de bank_details que NO son campos del formulario. */
const META_KEYS = new Set(['provider', 'bank_country', 'beneficiary_type']);

export function swiftValuesToBankDetails(
  values: Record<string, string>,
  meta: SwiftBankDetailsMeta,
): Record<string, unknown> {
  const details: Record<string, any> = {
    provider: 'tazapay',
    bank_country: meta.bank_country,
    beneficiary_type: meta.beneficiary_type,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    if (TOP_LEVEL_RENAMES[key]) {
      details[TOP_LEVEL_RENAMES[key]] = value;
      continue;
    }
    const [head, ...rest] = key.split('.');
    const sub = rest.join('.');
    if (head === 'bank' && sub) {
      details[sub] = value;
    } else if (NESTED_PREFIXES[head] && sub) {
      const container = NESTED_PREFIXES[head];
      details[container] = { ...(details[container] ?? {}), [sub]: value };
    } else {
      details[key] = value;
    }
  }
  return details;
}

/** Inversa de swiftValuesToBankDetails (para reintentos y ediciones). */
export function bankDetailsToSwiftValues(
  details: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  if (!details) return values;
  const dictionaryTopLevel = new Set([
    'name_local',
    'tax_id',
    'national_identification_number',
    'registration_number',
    'date_of_birth',
    'nationality',
  ]);
  for (const [key, value] of Object.entries(details)) {
    if (META_KEYS.has(key) || value === null || value === undefined) continue;
    if (RENAMES_REVERSE[key]) {
      if (isScalar(value)) values[RENAMES_REVERSE[key]] = String(value);
      continue;
    }
    const nestedHead = Object.entries(NESTED_PREFIXES).find(
      ([, c]) => c === key,
    )?.[0];
    if (nestedHead && typeof value === 'object') {
      for (const [sub, v] of Object.entries(value as Record<string, unknown>)) {
        if (isScalar(v) && v !== '') {
          values[`${nestedHead}.${sub}`] = String(v);
        }
      }
      continue;
    }
    if (!isScalar(value)) continue;
    if (dictionaryTopLevel.has(key)) {
      values[key] = String(value);
      continue;
    }
    values[`bank.${key}`] = String(value);
  }
  return values;
}

/** Texto o número: lo único que se guarda como valor de un campo. */
function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  );
}

/** Últimos 4 caracteres del número de cuenta o IBAN. */
export function accountLast4(values: Record<string, string>): string | null {
  const id = values['bank.account_number'] || values['bank.iban'];
  return id ? id.slice(-4) : null;
}

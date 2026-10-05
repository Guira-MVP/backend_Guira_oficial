/**
 * Diccionario de campos de beneficiario SWIFT de Tazapay.
 *
 * Tazapay decide QUÉ campos pide cada corredor (país + moneda), con la
 * metadata de GET /v3/metadata/payout/bank. Este archivo decide solo CÓMO se
 * muestra y valida cada campo. Es una lista cerrada y el único lugar donde se
 * agregan campos nuevos: el front no la copia, recibe etiquetas y patrones ya
 * resueltos dentro del esquema del formulario.
 *
 * Las claves son la ruta del campo dentro del body de POST /v3/beneficiary:
 *   bank.<campo>        → destination_details.bank.<campo>
 *   bank_codes.<código> → destination_details.bank.bank_codes.<código>
 *   address.<campo>     → address.<campo>
 *   phone.<campo>       → phone.<campo>
 *   <campo>             → campo de primer nivel del beneficiario
 */

export type SwiftFieldControl =
  | 'text'
  | 'email'
  | 'select'
  | 'phone_code'
  | 'bank_search'
  | 'country'
  | 'date';

/** Grupos del formulario, en el orden en que se pintan. */
export type SwiftFieldGroup =
  | 'holder'
  | 'account'
  | 'bank'
  | 'address'
  | 'extra';

export const SWIFT_FIELD_GROUP_ORDER: SwiftFieldGroup[] = [
  'holder',
  'account',
  'bank',
  'address',
  'extra',
];

/** Normalización que se aplica al valor antes de validar y enviar. */
export type SwiftFieldNormalize = 'trim' | 'upper' | 'compact_upper' | 'digits';

export interface SwiftFieldDefinition {
  key: string;
  label: string;
  control: SwiftFieldControl;
  group: SwiftFieldGroup;
  maxLength: number;
  pattern?: string;
  patternMessage?: string;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
  normalize: SwiftFieldNormalize;
}

const ALPHA2 = '^[A-Z]{2}$';

const FIELDS: SwiftFieldDefinition[] = [
  // ── Titular ────────────────────────────────────────────────────────────
  {
    key: 'bank.account_holder_name',
    label: 'Titular de la cuenta',
    control: 'text',
    group: 'holder',
    maxLength: 140,
    help: 'Tal como figura en el banco del beneficiario.',
    normalize: 'trim',
  },
  {
    key: 'name_local',
    label: 'Nombre en idioma local',
    control: 'text',
    group: 'holder',
    maxLength: 140,
    help: 'Nombre del titular en el alfabeto del país (p. ej. caracteres chinos).',
    normalize: 'trim',
  },
  // ── Cuenta ─────────────────────────────────────────────────────────────
  {
    key: 'bank.account_number',
    label: 'Número de cuenta',
    control: 'text',
    group: 'account',
    maxLength: 34,
    pattern: '^[A-Z0-9]{4,34}$',
    patternMessage: 'Entre 4 y 34 letras o números, sin espacios ni guiones.',
    normalize: 'compact_upper',
  },
  {
    key: 'bank.iban',
    label: 'IBAN',
    control: 'text',
    group: 'account',
    maxLength: 34,
    pattern: '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$',
    patternMessage:
      'IBAN inválido: 15 a 34 caracteres, empieza con el código del país.',
    normalize: 'compact_upper',
  },
  {
    key: 'bank.account_type',
    label: 'Tipo de cuenta',
    control: 'select',
    group: 'account',
    maxLength: 20,
    options: [
      { value: 'checking', label: 'Corriente' },
      { value: 'savings', label: 'Ahorro' },
      { value: 'payment', label: 'De pagos' },
    ],
    normalize: 'trim',
  },
  // ── Banco ──────────────────────────────────────────────────────────────
  {
    key: 'bank_codes.swift_code',
    label: 'Código SWIFT / BIC',
    control: 'bank_search',
    group: 'bank',
    maxLength: 11,
    pattern: '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$',
    patternMessage: 'El SWIFT tiene 8 u 11 caracteres (p. ej. CMBCCNBS).',
    normalize: 'compact_upper',
  },
  {
    key: 'bank.bank_name',
    label: 'Banco',
    control: 'text',
    group: 'bank',
    maxLength: 140,
    normalize: 'trim',
  },
  {
    key: 'bank.branch_name',
    label: 'Sucursal',
    control: 'text',
    group: 'bank',
    maxLength: 140,
    normalize: 'trim',
  },
  {
    key: 'bank_codes.bic_code',
    label: 'BIC',
    control: 'text',
    group: 'bank',
    maxLength: 11,
    pattern: '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$',
    patternMessage: 'El BIC tiene 8 u 11 caracteres.',
    normalize: 'compact_upper',
  },
  {
    key: 'bank_codes.aba_code',
    label: 'Routing ABA',
    control: 'text',
    group: 'bank',
    maxLength: 9,
    pattern: '^[0-9]{9}$',
    patternMessage: 'El ABA tiene 9 dígitos.',
    normalize: 'digits',
  },
  {
    key: 'bank_codes.sort_code',
    label: 'Sort code',
    control: 'text',
    group: 'bank',
    maxLength: 6,
    pattern: '^[0-9]{6}$',
    patternMessage: 'El sort code tiene 6 dígitos.',
    normalize: 'digits',
  },
  {
    key: 'bank_codes.ifsc_code',
    label: 'Código IFSC',
    control: 'text',
    group: 'bank',
    maxLength: 11,
    pattern: '^[A-Z]{4}0[A-Z0-9]{6}$',
    patternMessage: 'El IFSC tiene 11 caracteres (p. ej. HDFC0001234).',
    normalize: 'compact_upper',
  },
  {
    key: 'bank_codes.bsb_code',
    label: 'Código BSB',
    control: 'text',
    group: 'bank',
    maxLength: 6,
    pattern: '^[0-9]{6}$',
    patternMessage: 'El BSB tiene 6 dígitos.',
    normalize: 'digits',
  },
  {
    key: 'bank_codes.cnaps',
    label: 'Código CNAPS',
    control: 'text',
    group: 'bank',
    maxLength: 12,
    pattern: '^[0-9]{12}$',
    patternMessage: 'El CNAPS tiene 12 dígitos.',
    normalize: 'digits',
  },
  {
    key: 'bank_codes.bank_code',
    label: 'Código del banco',
    control: 'text',
    group: 'bank',
    maxLength: 20,
    normalize: 'compact_upper',
  },
  {
    key: 'bank_codes.branch_code',
    label: 'Código de sucursal',
    control: 'text',
    group: 'bank',
    maxLength: 20,
    normalize: 'compact_upper',
  },
  // ── Dirección del beneficiario ─────────────────────────────────────────
  {
    key: 'address.line1',
    label: 'Dirección',
    control: 'text',
    group: 'address',
    maxLength: 140,
    normalize: 'trim',
  },
  {
    key: 'address.line2',
    label: 'Dirección (línea 2)',
    control: 'text',
    group: 'address',
    maxLength: 140,
    normalize: 'trim',
  },
  {
    key: 'address.city',
    label: 'Ciudad',
    control: 'text',
    group: 'address',
    maxLength: 100,
    normalize: 'trim',
  },
  {
    key: 'address.state',
    label: 'Estado / provincia',
    control: 'text',
    group: 'address',
    maxLength: 100,
    normalize: 'trim',
  },
  {
    key: 'address.postal_code',
    label: 'Código postal',
    control: 'text',
    group: 'address',
    maxLength: 20,
    normalize: 'trim',
  },
  {
    key: 'address.country',
    label: 'País de la dirección',
    control: 'country',
    group: 'address',
    maxLength: 2,
    pattern: ALPHA2,
    patternMessage: 'Código de país de 2 letras.',
    normalize: 'upper',
  },
  // ── Contacto y datos adicionales ───────────────────────────────────────
  {
    key: 'phone.calling_code',
    label: 'Código de país del teléfono',
    control: 'phone_code',
    group: 'extra',
    maxLength: 5,
    pattern: '^\\+?[0-9]{1,4}$',
    patternMessage: 'Código de país numérico (p. ej. 86).',
    placeholder: '86',
    normalize: 'trim',
  },
  {
    key: 'phone.number',
    label: 'Teléfono',
    control: 'text',
    group: 'extra',
    maxLength: 15,
    pattern: '^[0-9]{4,15}$',
    patternMessage: 'Solo números, sin el código de país.',
    normalize: 'digits',
  },
  {
    key: 'email',
    label: 'Email del beneficiario',
    control: 'email',
    group: 'extra',
    maxLength: 254,
    pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    patternMessage: 'Email inválido.',
    normalize: 'trim',
  },
  {
    key: 'tax_id',
    label: 'Identificación tributaria',
    control: 'text',
    group: 'extra',
    maxLength: 50,
    normalize: 'trim',
  },
  {
    key: 'national_identification_number',
    label: 'Documento de identidad',
    control: 'text',
    group: 'extra',
    maxLength: 50,
    normalize: 'trim',
  },
  {
    key: 'registration_number',
    label: 'Número de registro de la empresa',
    control: 'text',
    group: 'extra',
    maxLength: 50,
    normalize: 'trim',
  },
  {
    key: 'date_of_birth',
    label: 'Fecha de nacimiento',
    control: 'date',
    group: 'extra',
    maxLength: 10,
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
    patternMessage: 'Fecha inválida.',
    normalize: 'trim',
  },
  {
    key: 'nationality',
    label: 'Nacionalidad',
    control: 'country',
    group: 'extra',
    maxLength: 2,
    pattern: ALPHA2,
    patternMessage: 'Código de país de 2 letras.',
    normalize: 'upper',
  },
];

export const SWIFT_FIELD_DICTIONARY: ReadonlyMap<string, SwiftFieldDefinition> =
  new Map(FIELDS.map((f) => [f.key, f]));

/** Orden de cada clave dentro del diccionario (para pintar de forma estable). */
export const SWIFT_FIELD_ORDER: ReadonlyMap<string, number> = new Map(
  FIELDS.map((f, i) => [f.key, i]),
);

/**
 * Campos que Guira pide siempre, aunque la metadata no los liste: sin ellos
 * no hay beneficiario SWIFT posible (Tazapay los exige igual en el alta).
 */
export const SWIFT_BASE_REQUIRED_KEYS = [
  'bank.account_holder_name',
  'bank.account_number',
  'bank.bank_name',
  'bank_codes.swift_code',
];

/**
 * Traduce una clave de la metadata de Tazapay a claves del diccionario.
 * `section` indica de qué lista vino: required_bank_fields → bank,
 * required_bank_codes → bank_codes, required_beneficiary_fields → beneficiary
 * (que ya viene en notación con punto: "address.city").
 */
export function metadataKeyToDictionaryKeys(
  section: 'bank' | 'bank_codes' | 'beneficiary',
  raw: string,
): string[] {
  const key = String(raw ?? '').trim();
  if (!key) return [];
  if (section === 'bank') return [`bank.${key}`];
  if (section === 'bank_codes') return [`bank_codes.${key}`];
  if (key === 'phone') return ['phone.calling_code', 'phone.number'];
  if (key === 'address') {
    return [
      'address.line1',
      'address.city',
      'address.state',
      'address.postal_code',
    ];
  }
  return [key];
}

/** Las claves de regla pueden ser grupos ("phone"): se expanden igual. */
export function ruleKeyToDictionaryKeys(raw: string): string[] {
  if (raw === 'phone' || raw === 'address') {
    return metadataKeyToDictionaryKeys('beneficiary', raw);
  }
  return [raw];
}

/** Etiqueta legible para una clave que no está en el diccionario. */
export function fallbackLabel(key: string): string {
  const last = key.split('.').pop() ?? key;
  const text = last.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Aplica la normalización del campo a un valor ingresado por el cliente. */
export function normalizeSwiftValue(
  def: Pick<SwiftFieldDefinition, 'normalize'> | undefined,
  value: unknown,
): string {
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'number'
        ? String(value)
        : '';
  switch (def?.normalize) {
    case 'upper':
      return text.trim().toUpperCase();
    case 'compact_upper':
      return text.replace(/[\s-]/g, '').toUpperCase();
    case 'digits':
      return text.replace(/\D/g, '');
    default:
      return text.trim();
  }
}

/** Verificación Mod-97 de un IBAN ya normalizado. */
export function isValidIbanChecksum(iban: string): boolean {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

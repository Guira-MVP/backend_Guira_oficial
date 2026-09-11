/**
 * mask-bank-details.ts
 *
 * Enmascarado de números de cuenta en los expedientes que se devuelven a
 * alguien que consulta la cuenta de otra empresa (acceso vinculado).
 *
 * Se aplica en el backend, al serializar, y no en el frontend: si se
 * hiciera en la interfaz el número completo seguiría viajando en la
 * respuesta HTTP y bastaría con abrir las herramientas del navegador para
 * leerlo.
 *
 * El titular de la cuenta nunca pasa por aquí — ve sus propios datos
 * completos, como siempre.
 */

/** Deja los últimos 4 caracteres visibles: `••••3312`. */
export function maskAccountNumber(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  if (trimmed.length <= 4) return '••••';

  return `••••${trimmed.slice(-4)}`;
}

/** Campos de cuenta dentro de los JSON de instrucciones de depósito. */
const NESTED_ACCOUNT_FIELDS = [
  'account_number',
  'bank_account_number',
  'routing_number',
  'bank_routing_number',
  'iban',
];

function maskInstructions(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const source = value as Record<string, unknown>;
  const masked: Record<string, unknown> = { ...source };

  for (const field of NESTED_ACCOUNT_FIELDS) {
    if (field in masked) {
      masked[field] = maskAccountNumber(masked[field]);
    }
  }

  return masked;
}

/** Campos de cuenta en la propia fila del expediente. */
const TOP_LEVEL_ACCOUNT_FIELDS = [
  'destination_account_number',
  'sender_bank_routing_number',
];

const INSTRUCTION_FIELDS = [
  'psav_deposit_instructions',
  'bridge_source_deposit_instructions',
];

/**
 * Devuelve una copia del expediente con los números de cuenta
 * enmascarados. No muta el original.
 */
export function maskOrderBankDetails<T extends Record<string, any>>(
  order: T,
): T {
  if (!order || typeof order !== 'object') return order;

  const masked: Record<string, unknown> = { ...order };

  for (const field of TOP_LEVEL_ACCOUNT_FIELDS) {
    if (field in masked) {
      masked[field] = maskAccountNumber(masked[field]);
    }
  }

  for (const field of INSTRUCTION_FIELDS) {
    if (field in masked) {
      masked[field] = maskInstructions(masked[field]);
    }
  }

  return masked as T;
}

/**
 * Aplica el enmascarado solo cuando hace falta: hay contexto vinculado y
 * ese contexto no incluye el permiso de ver los datos completos.
 *
 * Recibe `null` para el titular, que es el caso de todo el tráfico actual.
 */
export function maskOrdersIfNeeded<T extends Record<string, any>>(
  orders: T[],
  linkedAccess: { capabilities: string[] } | null | undefined,
): T[] {
  if (!linkedAccess || linkedAccess.capabilities.includes('bank_details:full')) {
    return orders;
  }

  return orders.map((order) => maskOrderBankDetails(order));
}

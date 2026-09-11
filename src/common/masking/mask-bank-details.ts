/**
 * mask-bank-details.ts
 *
 * Enmascarado de identificadores de cuenta en todo lo que se devuelve a
 * alguien que consulta la cuenta de otra empresa (acceso vinculado), salvo
 * que el titular le haya concedido `bank_details:full`.
 *
 * Se aplica en el backend, al serializar, y no en el frontend: si se
 * hiciera en la interfaz el número completo seguiría viajando en la
 * respuesta HTTP y bastaría con abrir las herramientas del navegador para
 * leerlo.
 *
 * El titular de la cuenta nunca pasa por aquí — ve sus propios datos
 * completos, como siempre.
 *
 * Criterio de qué se enmascara: los identificadores que permiten **operar
 * contra** una cuenta (número de cuenta, routing, dirección cripto). No se
 * enmascara lo que sirve para **identificar** al titular o al banco
 * (nombre del beneficiario, nombre del banco, SWIFT), porque sin eso un
 * contable no puede hacer su trabajo y además no es información secreta.
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

// ─── Proveedores / beneficiarios ────────────────────────────────────

/**
 * Campos sensibles dentro de `suppliers.bank_details`.
 *
 * Se dejan sin tocar `bank_name`, `account_holder_name` y `swift_code`: el
 * SWIFT es un identificador público de la entidad, no un secreto, y los
 * otros dos son justo lo que necesita quien concilia para saber a quién se
 * pagó.
 */
const SUPPLIER_BANK_FIELDS = [
  'account_number',
  'routing_number',
  'crypto_address',
];

/** Devuelve una copia del proveedor con los identificadores ocultos. */
export function maskSupplierBankDetails<T extends Record<string, any>>(
  supplier: T,
): T {
  if (!supplier || typeof supplier !== 'object') return supplier;

  const details = supplier.bank_details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return supplier;
  }

  const maskedDetails: Record<string, unknown> = { ...details };
  for (const field of SUPPLIER_BANK_FIELDS) {
    if (field in maskedDetails) {
      maskedDetails[field] = maskAccountNumber(maskedDetails[field]);
    }
  }

  return { ...supplier, bank_details: maskedDetails };
}

// ─── Wallets ────────────────────────────────────────────────────────

/**
 * La dirección de una wallet es el equivalente cripto de un número de
 * cuenta, así que se trata igual.
 */
export function maskWalletAddress<T extends Record<string, any>>(
  wallet: T,
): T {
  if (!wallet || typeof wallet !== 'object' || !('address' in wallet)) {
    return wallet;
  }

  return { ...wallet, address: maskAccountNumber(wallet.address) };
}

// ─── Cuenta bancaria propia del cliente ─────────────────────────────

/**
 * `client_bank_accounts` guarda el número en una columna plana. Se oculta
 * igual que el resto; el nombre del banco y del titular se conservan.
 */
export function maskClientBankAccount<T extends Record<string, any>>(
  account: T,
): T {
  if (!account || typeof account !== 'object' || !('account_number' in account)) {
    return account;
  }

  return {
    ...account,
    account_number: maskAccountNumber(account.account_number),
  };
}

// ─── Punto de decisión único ────────────────────────────────────────

/**
 * ¿Hay que ocultar los identificadores de cuenta en esta petición?
 *
 * Solo cuando hay contexto vinculado y ese contexto NO incluye
 * `bank_details:full`. Para el titular —el 100% del tráfico actual—
 * devuelve false y no se toca nada.
 *
 * Un contexto vinculado sin permisos se enmascara: ante la duda, el caso
 * por defecto es el cerrado.
 */
export function shouldMask(
  linkedAccess: { capabilities: string[] } | null | undefined,
): boolean {
  if (!linkedAccess) return false;
  return !linkedAccess.capabilities.includes('bank_details:full');
}

export function maskOrdersIfNeeded<T extends Record<string, any>>(
  orders: T[],
  linkedAccess: { capabilities: string[] } | null | undefined,
): T[] {
  if (!shouldMask(linkedAccess)) return orders;
  return orders.map((order) => maskOrderBankDetails(order));
}

export function maskSuppliersIfNeeded<T extends Record<string, any>>(
  suppliers: T[],
  linkedAccess: { capabilities: string[] } | null | undefined,
): T[] {
  if (!shouldMask(linkedAccess)) return suppliers;
  return suppliers.map((supplier) => maskSupplierBankDetails(supplier));
}

export function maskWalletsIfNeeded<T extends Record<string, any>>(
  wallets: T[],
  linkedAccess: { capabilities: string[] } | null | undefined,
): T[] {
  if (!shouldMask(linkedAccess)) return wallets;
  return wallets.map((wallet) => maskWalletAddress(wallet));
}

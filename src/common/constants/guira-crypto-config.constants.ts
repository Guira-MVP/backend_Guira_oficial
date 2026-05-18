// ═══════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN CRYPTO GUIRA — ETAPA 1
//  Fuente única de verdad para redes blockchain, monedas crypto
//  y validación de direcciones en el backend NestJS.
//
//  El frontend tiene su réplica en:
//  m-guira/lib/guira-crypto-config.ts
// ═══════════════════════════════════════════════════════════════════

// ── REDES PERMITIDAS (Etapa 1) ──────────────────────────────────
// 6 redes habilitadas para transfers, VA, proveedores, etc.
// La wallet custodial es solo Solana por ahora (definido en app_settings).
export const ALLOWED_NETWORKS = [
  'base',
  'ethereum',
  'solana',
  'tron',
  'polygon',
  'stellar',
] as const;

// ── MONEDAS CRYPTO PERMITIDAS (Etapa 1) ─────────────────────────
export const ALLOWED_CRYPTO_CURRENCIES = [
  'usdb',
  'usdc',
  'usdt',
  'pyusd',
  'eurc',
] as const;

// ── MONEDAS FIAT SOPORTADAS ─────────────────────────────────────
export const ALLOWED_FIAT_CURRENCIES = [
  'usd',
  'eur',
  'mxn',
  'brl',
  'gbp',
  'cop',
] as const;

// ── VALIDACIÓN DE DIRECCIONES POR RED ───────────────────────────
export const ADDRESS_VALIDATORS: Record<
  string,
  { regex: RegExp; description: string }
> = {
  ethereum: { regex: /^0x[0-9a-fA-F]{40}$/, description: '0x + 40 hex chars' },
  polygon: {
    regex: /^0x[0-9a-fA-F]{40}$/,
    description: '0x + 40 hex chars (EVM)',
  },
  base: {
    regex: /^0x[0-9a-fA-F]{40}$/,
    description: '0x + 40 hex chars (EVM)',
  },
  solana: {
    regex: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    description: 'Base58, 32-44 chars',
  },
  tron: {
    regex: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    description: 'T + 33 chars Base58',
  },
  stellar: { regex: /^G[A-Z2-7]{55}$/, description: 'G + 55 chars' },
};

/**
 * Valida una dirección blockchain según la red seleccionada.
 * @returns true si la dirección es válida para la red, false si no.
 */
export function validateCryptoAddress(
  address: string,
  network: string,
): boolean {
  const validator = ADDRESS_VALIDATORS[network.toLowerCase()];
  if (!validator) return false;
  return validator.regex.test(address.trim());
}

/**
 * Verifica que una red está en la whitelist de Etapa 1.
 */
export function isAllowedNetwork(network: string): boolean {
  return (ALLOWED_NETWORKS as readonly string[]).includes(
    network.toLowerCase(),
  );
}

/**
 * Verifica que una moneda crypto está en la whitelist de Etapa 1.
 */
export function isAllowedCryptoCurrency(currency: string): boolean {
  return (ALLOWED_CRYPTO_CURRENCIES as readonly string[]).includes(
    currency.toLowerCase(),
  );
}

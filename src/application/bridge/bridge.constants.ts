/**
 * ═══════════════════════════════════════════════════════════════════
 *  BRIDGE CONSTANTS — Configuración centralizada del módulo Bridge
 * ═══════════════════════════════════════════════════════════════════
 *
 * Centraliza mapeos, constantes y configuraciones que dependen de la
 * API de Bridge para evitar valores mágicos dispersos en el código.
 *
 * IMPORTANTE: Si Bridge agrega nuevos payment rails o account types,
 * actualizar ÚNICAMENTE este archivo.
 */

// ── Payment Rail → Bridge Account Type ──────────────────────────────
//
// Bridge utiliza un campo `account_type` para identificar el tipo de
// cuenta bancaria (us, iban, clabe, pix, bre_b, gb).
// Guira usa `payment_rail` como identificador interno (ach, wire, sepa, etc.)
//
// Este mapeo convierte uno al otro de forma centralizada.
//
// Referencia Bridge API v0:
//   - us      → ACH / Wire (EE.UU.)
//   - iban    → SEPA (Europa)
//   - clabe   → SPEI (México)
//   - pix     → PIX (Brasil)
//   - bre_b   → Bre-B (Colombia, Beta)
//   - gb      → Faster Payments (Reino Unido)

export const PAYMENT_RAIL_TO_BRIDGE_ACCOUNT_TYPE: Readonly<
  Record<string, string>
> = {
  ach: 'us',
  wire: 'us',
  sepa: 'iban',
  spei: 'clabe',
  pix: 'pix',
  bre_b: 'bre_b',
  faster_payments: 'gb',
  co_bank_transfer: 'co_bank_transfer',
} as const;

// ── Monedas soportadas para Virtual Accounts ────────────────────────

export const SUPPORTED_VA_SOURCE_CURRENCIES = [
  'usd',
  'eur',
  'mxn',
  'brl',
  'gbp',
  'cop',
] as const;

export type VaSourceCurrency = (typeof SUPPORTED_VA_SOURCE_CURRENCIES)[number];

// ── Tipos de destino de Virtual Accounts ────────────────────────────

export const VA_DESTINATION_TYPES = [
  'wallet_bridge',
  'wallet_external',
] as const;

export type VaDestinationType = (typeof VA_DESTINATION_TYPES)[number];

// ── Monedas crypto destino soportadas ───────────────────────────────

export const SUPPORTED_DESTINATION_CURRENCIES = [
  'usdc',
  'usdt',
  'usdb',
  'dai',
  'pyusd',
  'eurc',
] as const;

export type DestinationCurrency =
  (typeof SUPPORTED_DESTINATION_CURRENCIES)[number];

// ── Límites de creación de VAs por usuario ──────────────────────────
//
// NOTA: Estos valores ahora se configuran desde el panel de admin
// en la tabla `app_settings` con las keys:
//   - VA_MAX_TOTAL_ACTIVE_PER_USER (default: 24)
//   - VA_MAX_EXTERNAL_PER_CURRENCY (default: 3)
// Ver: BridgeService.getVaCreationLimits()

// ── Rate Limiting: VA Creation ──────────────────────────────────────

export const VA_THROTTLE_CONFIG = {
  /** Máximo de requests de creación de VA por ventana de tiempo */
  limit: 6,
  /** Ventana de tiempo en milisegundos (10 minutos) */
  ttl: 600_000,
} as const;

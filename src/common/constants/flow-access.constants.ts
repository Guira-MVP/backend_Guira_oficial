/**
 * flow-access.constants.ts
 *
 * Fuente única de verdad para la VISIBILIDAD de flujos de servicio por cliente.
 *
 * La unidad de control es el `flow_type` (mismos valores que InterbankFlowType /
 * WalletRampFlowType de los DTOs de payment-orders).
 *
 * Regla por país:
 *   - Bolivia (BOL) o país indeterminado (NULL) → ve los 9 flujos gobernados.
 *   - Cualquier otro país → solo los flujos globales (NON_BOLIVIA_DEFAULT_FLOWS).
 *
 * El override de staff (tabla customer_flow_overrides) tiene prioridad sobre el
 * default por país y aplica también a clientes bolivianos.
 *
 * Fuera de alcance (NO gobernados aquí, permanecen como están): world_to_wallet,
 * wallet_to_fiat y la creación de Virtual Accounts.
 */

/** Códigos de Bolivia aceptados (alpha-3 preferido; alpha-2 por compatibilidad). */
export const BOLIVIA_COUNTRY_CODES = ['BOL', 'BO'] as const;

/** Los 9 flujos de pago sujetos a la regla de visibilidad por país + override. */
export const COUNTRY_GOVERNED_FLOWS = [
  // Interbank
  'bolivia_to_world',
  'bolivia_to_wallet',
  'wallet_to_wallet',
  'world_to_bolivia',
  // Wallet Ramp
  'fiat_bo_to_bridge_wallet',
  'crypto_to_bridge_wallet',
  'bridge_wallet_to_fiat_bo',
  'bridge_wallet_to_crypto',
  'bridge_wallet_to_fiat_us',
] as const;

/**
 * Flujos gobernados "siempre-encendidos": habilitados por defecto para TODOS los
 * clientes sin importar el país, pero el override de staff puede apagarlos por
 * cliente. Hoy: la sección de Cuentas Virtuales (Bridge).
 */
export const ALWAYS_ON_FLOWS = ['virtual_account'] as const;

/**
 * Flujos gobernados "siempre-apagados": deshabilitados por defecto para TODOS los
 * clientes. El staff debe habilitarlos explícitamente por cliente (opt-in).
 * Hoy: Wallet Externa en Cuentas Virtuales (requiere habilitación por solicitud).
 */
export const ALWAYS_OFF_FLOWS = ['virtual_account_external'] as const;

/** Identificador del flujo de Cuentas Virtuales (no es un flow_type de payment_orders). */
export const VIRTUAL_ACCOUNT_FLOW = 'virtual_account';

/** Identificador del flujo de Wallet Externa en Cuentas Virtuales. */
export const VIRTUAL_ACCOUNT_EXTERNAL_FLOW = 'virtual_account_external';

/** Todos los flujos gobernados (sujetos a override de staff + panel). */
export const GOVERNED_FLOWS = [
  ...COUNTRY_GOVERNED_FLOWS,
  ...ALWAYS_ON_FLOWS,
  ...ALWAYS_OFF_FLOWS,
] as const;

export type GovernedFlow = (typeof GOVERNED_FLOWS)[number];

/** Flujos de pago que un cliente NO boliviano ve por defecto (sin override). */
export const NON_BOLIVIA_DEFAULT_FLOWS: readonly GovernedFlow[] = [
  'wallet_to_wallet',
  'crypto_to_bridge_wallet',
  'bridge_wallet_to_crypto',
  'bridge_wallet_to_fiat_us',
];

/** True si el flow_type es uno de los gobernados por este subsistema. */
export function isGovernedFlow(flowType: string): flowType is GovernedFlow {
  return (GOVERNED_FLOWS as readonly string[]).includes(flowType);
}

/** True si el país se considera Bolivia. NULL/undefined → Bolivia (permisivo). */
export function isBoliviaCountry(countryCode?: string | null): boolean {
  if (!countryCode) return true;
  return (BOLIVIA_COUNTRY_CODES as readonly string[]).includes(countryCode.toUpperCase());
}

/**
 * Default por país: conjunto de flujos visibles ANTES de aplicar overrides.
 * Incluye siempre los flujos "siempre-encendidos" (ALWAYS_ON_FLOWS), que no
 * dependen del país.
 * @param countryCode ISO alpha-3 del cliente (NULL → Bolivia).
 */
export function resolveDefaultFlows(countryCode?: string | null): GovernedFlow[] {
  const countryFlows: readonly GovernedFlow[] = isBoliviaCountry(countryCode)
    ? COUNTRY_GOVERNED_FLOWS
    : NON_BOLIVIA_DEFAULT_FLOWS;
  return [...countryFlows, ...ALWAYS_ON_FLOWS];
}

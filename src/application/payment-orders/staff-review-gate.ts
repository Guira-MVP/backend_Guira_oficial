/**
 * Puerta de revisión de staff entre "expediente creado" y "Bridge Transfer
 * enviado al proveedor".
 *
 * Antes de este módulo, los 4 flujos de salida de fondos creaban el expediente
 * y el transfer en la misma petición HTTP: el dinero salía hacia el proveedor
 * sin que nadie hubiese verificado el motivo declarado (`business_purpose`) ni
 * el documento de respaldo (`supporting_document_url`) que subió el cliente.
 *
 * Ahora el expediente nace en 'pending_review' y el transfer se crea recién
 * cuando un miembro del staff aprueba la revisión.
 *
 * El contexto de ejecución (`BridgeExecContext`) se persiste en
 * `payment_orders.bridge_execution_context` y es lo que permite ejecutar el
 * tramo Bridge horas después sin re-resolver rutas ni recalcular comisiones.
 */

/**
 * Flujos que el código sabe ejecutar en dos fases y que, por tanto, PUEDEN
 * pasar por la puerta de revisión.
 *
 * Que un flujo esté aquí no significa que la puerta esté activa: eso lo decide
 * el staff flujo por flujo desde el panel (tabla `flow_review_settings`, ver
 * FlowReviewSettingsService.requiresReview). Esta lista es la otra mitad de la
 * condición — el soporte técnico — y evita que una fila suelta en la tabla
 * active la puerta en un flujo sin ejecutor.
 *
 * `va_deposit` queda fuera a propósito: no lo crea el cliente, lo dispara un
 * webhook de Bridge cuando llega dinero a una cuenta virtual. No hay nada que
 * revisar antes de que ocurra.
 */
export const STAFF_REVIEW_GATED_FLOWS = [
  // Interbank
  'bolivia_to_world',
  'bolivia_to_wallet',
  'world_to_bolivia',
  'wallet_to_wallet',
  // Wallet ramp — entrada de fondos
  'fiat_bo_to_bridge_wallet',
  'crypto_to_bridge_wallet',
  // Wallet ramp — salida de fondos
  'bridge_wallet_to_fiat_bo',
  'bridge_wallet_to_crypto',
  'bridge_wallet_to_fiat_us',
  'wallet_to_world',
] as const;

export type StaffReviewGatedFlow = (typeof STAFF_REVIEW_GATED_FLOWS)[number];

/**
 * ¿El código soporta la puerta de revisión en este flujo?
 *
 * OJO: esto NO responde "¿hay que revisar este expediente?". Para eso está
 * `FlowReviewSettingsService.requiresReview`, que además consulta el switch del
 * panel. Úsalo aquí solo como guarda de defensa en profundidad.
 */
export function supportsStaffReviewGate(
  flowType: string | null | undefined,
): boolean {
  return (STAFF_REVIEW_GATED_FLOWS as readonly string[]).includes(
    flowType ?? '',
  );
}

/**
 * Qué hacer si el tramo Bridge falla.
 *
 * - `fail_order`: comportamiento histórico (camino sin puerta). Libera la
 *   reserva, marca el expediente 'failed', manda el email de fallo y lanza.
 * - `return_to_review`: el expediente vuelve a 'pending_review' para que el
 *   staff pueda reintentar. NO libera la reserva (el expediente sigue vivo) y
 *   NO manda email de fallo. Es seguro porque las Idempotency-Key de Bridge son
 *   función pura del id del expediente.
 */
export type BridgeLegFailureMode = 'fail_order' | 'return_to_review';

/** Resultado de ejecutar el tramo Bridge de un expediente. */
export interface BridgeLegResult {
  bridge_transfer_id: string | null;
  /** Estado en el que queda el expediente: 'processing' o 'waiting_deposit'. */
  status: string;
}

interface ExecContextBase {
  /**
   * Discriminante del ejecutor. OJO: la rama Perú tiene su propio `kind` aunque
   * su fila lleve `flow_type = 'bridge_wallet_to_fiat_us'`. El dispatcher debe
   * hacer switch sobre `kind`, NUNCA sobre `order.flow_type`: si no, a un
   * expediente peruano se le pediría a Bridge pagar a un `external_account_id`
   * que no existe.
   */
  kind:
    | 'bridge_wallet_to_fiat_bo'
    | 'bridge_wallet_to_crypto'
    | 'bridge_wallet_to_fiat_us'
    | 'bridge_wallet_to_peru_psav'
    | 'wallet_to_world'
    | 'psav_deposit'
    | 'fiat_bo_to_bridge_wallet'
    | 'crypto_to_bridge_wallet'
    | 'wallet_to_wallet';
  /** Divisa de origen en MAYÚSCULA (la que se reservó). */
  source_currency: string;
  amount: number;
  fee_amount: number;
  net_amount: number;
  /**
   * Monto bloqueado con `reserve_balance` al crear el expediente. Es la única
   * fuente válida para liberarlo al rechazar: un expediente en 'pending_review'
   * todavía NO tiene filas en `ledger_entries` (se escriben después del tramo
   * Bridge), así que el escaneo de ledger que usan failOrder/cancelOrderByStaff
   * devolvería 0 y la reserva quedaría huérfana.
   *
   * Vale 0 en wallet_to_world, que nunca reserva nada.
   */
  total_needed: number;
}

export interface FiatBoExecContext extends ExecContextBase {
  kind: 'bridge_wallet_to_fiat_bo';
  /** Se relee al aprobar para obtener crypto_address + crypto_network frescos. */
  psav_account_id: string;
  /** Divisa destino ya elegida por resolveFiatBoPsavMatch. No se re-resuelve. */
  psav_dest_currency: string;
}

export interface CryptoExecContext extends ExecContextBase {
  kind: 'bridge_wallet_to_crypto';
  /** Riel de destino normalizado y validado contra ALLOWED_NETWORKS. */
  destination_rail: string;
  /** En minúscula, como lo espera Bridge. */
  destination_currency: string;
  destination_address: string;
}

export interface FiatUsExecContext extends ExecContextBase {
  kind: 'bridge_wallet_to_fiat_us';
  /**
   * Riel congelado. NO se relee del supplier: el riel determina el rail_ref Y
   * la comisión ya congelada en fee_amount. Si el cliente cambiase su proveedor
   * de ACH a Wire durante la revisión, se enviaría un transfer cuyo riel no
   * cuadra con el fee cobrado.
   */
  supplier_payment_rail: string;
  /** Id LOCAL en bridge_external_accounts. Se relee para validar is_active. */
  external_account_local_id: string;
  /** En minúscula. */
  destination_currency: string;
}

export interface PeruExecContext extends ExecContextBase {
  kind: 'bridge_wallet_to_peru_psav';
  psav_account_id: string;
  psav_dest_currency: string;
}

export interface WalletToWorldExecContext extends ExecContextBase {
  kind: 'wallet_to_world';
  /** Red on-chain desde la que llegará el depósito externo, en minúscula. */
  source_network: string;
  supplier_payment_rail: string;
  external_account_local_id: string;
  destination_currency: string;
}

/**
 * Flujos de entrada donde el cliente deposita contra una cuenta del PSAV y no
 * hay ninguna llamada a Bridge en la creación: bolivia_to_world,
 * bolivia_to_wallet y world_to_bolivia.
 *
 * Lo que se retiene durante la revisión son las INSTRUCCIONES DE DEPÓSITO: el
 * expediente nace sin ellas para que el cliente no pueda ingresar dinero antes
 * de que el staff valide la documentación. Rechazar después de un depósito
 * recibido obligaría a un reembolso manual.
 */
export interface PsavDepositExecContext extends ExecContextBase {
  kind: 'psav_deposit';
  /** Tipo de canal en psav_accounts: bank_bo, bank_us, bank_eu, … */
  psav_type: string;
  /** Divisa del canal, en MAYÚSCULA. */
  psav_currency: string;
}

/**
 * On-ramp BOB → wallet Bridge. Retiene DOS cosas durante la revisión: la cuenta
 * bancaria boliviana donde el cliente deposita, y la dirección de liquidación
 * de Bridge que el PSAV usa para fondear la wallet.
 */
export interface FiatBoOnRampExecContext extends ExecContextBase {
  kind: 'fiat_bo_to_bridge_wallet';
  /** Canal PSAV en BOB donde deposita el cliente. */
  psav_type: string;
  psav_currency: string;
  /** `source` del transfer Bridge: el riel/divisa con que el PSAV liquida. */
  psav_source_payment_rail: string;
  psav_source_currency: string;
  /** Red y token de la wallet Bridge de destino. */
  wallet_network: string;
  destination_currency: string;
  /** Congelados: derivan del importe y la tasa aceptados por el cliente. */
  developer_fee_percent: string;
  bridge_amount_estimated: number;
  net_amount_destination: number;
}

/** On-ramp cripto externo → wallet Bridge, con importe flexible. */
export interface CryptoOnRampExecContext extends ExecContextBase {
  kind: 'crypto_to_bridge_wallet';
  source_network: string;
  source_currency_lower: string;
  wallet_network: string;
  destination_currency: string;
  fee_percent: string;
}

/** Cripto externo → wallet del proveedor, con importe flexible. */
export interface WalletToWalletExecContext extends ExecContextBase {
  kind: 'wallet_to_wallet';
  source_network: string;
  source_currency_lower: string;
  destination_rail: string;
  destination_currency: string;
  destination_address: string;
  fee_percent: string;
}

export type BridgeExecContext =
  | FiatBoExecContext
  | CryptoExecContext
  | FiatUsExecContext
  | PeruExecContext
  | WalletToWorldExecContext
  | PsavDepositExecContext
  | FiatBoOnRampExecContext
  | CryptoOnRampExecContext
  | WalletToWalletExecContext;

/**
 * Monto y divisa a devolver con `release_reserved_balance` al cerrar un
 * expediente que murió en 'pending_review'.
 *
 * Devuelve null cuando no hay nada que liberar (wallet_to_world, o un contexto
 * ausente). `release_reserved_balance` incrementa el disponible sin comprobar
 * nada: llamarlo sobre un flujo que nunca reservó regala saldo.
 */
export function resolvePendingReviewReserve(order: {
  currency?: string | null;
  source_currency?: string | null;
  bridge_execution_context?: unknown;
}): { currency: string; amount: number } | null {
  const ctx = order.bridge_execution_context as BridgeExecContext | null;
  const amount = Number(ctx?.total_needed ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const currency = (
    ctx?.source_currency ??
    order.source_currency ??
    order.currency ??
    ''
  ).toUpperCase();
  if (!currency) return null;

  return { currency, amount };
}

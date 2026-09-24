/**
 * Política de cancelación de expedientes — fuente única de verdad.
 *
 * Antes cada capa decidía por su cuenta: el backend permitía cancelar en
 * ['created','waiting_deposit'] para los 10 flujos por igual, y el frontend
 * mostraba el botón con otra regla distinta (incluyendo 'processing' para los
 * wallet-ramp, donde el backend siempre respondía 400). Este módulo centraliza
 * la decisión para que backend, serializador y tests usen exactamente el mismo
 * criterio.
 *
 * El eje real no es el estado, es DÓNDE ESTÁ EL DINERO:
 *   - fiat_in_bo      → el cliente deposita BOB en la cuenta del PSAV, fuera de
 *                       la plataforma. No hay forma de detectarlo automáticamente,
 *                       así que exigimos una declaración explícita.
 *   - crypto_in       → el cliente envía cripto a una dirección de Bridge. El
 *                       estado del transfer en Bridge es la única fuente fiable
 *                       de si los fondos ya salieron.
 *   - wallet_ramp_out → los fondos salen de la wallet Bridge del cliente en el
 *                       mismo request que crea la orden. Nunca hay ventana segura.
 */

export type CancellationGroup = 'fiat_in_bo' | 'crypto_in' | 'wallet_ramp_out';

export type CancellationActor = 'client' | 'staff';

export type CancellationReasonCode =
  | 'FLOW_NOT_CANCELLABLE'
  | 'TERMINAL_STATUS'
  | 'STATUS_NOT_CANCELLABLE'
  | 'FUNDS_IN_FLIGHT'
  | 'DEPOSIT_DECLARATION_REQUIRED';

export interface CancellationDecision {
  allowed: boolean;
  reason_code: CancellationReasonCode | null;
  /** Mensaje en español, apto para mostrar directamente al cliente. */
  message: string | null;
}

/** Estados terminales: nunca se cancelan, ni por cliente ni por staff. */
export const TERMINAL_ORDER_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'refunded',
  'swept_external',
] as const;

/**
 * Único estado de Bridge en el que un transfer admite DELETE. Cualquier otro
 * significa que Bridge ya recibió o movió los fondos: cancelar ahí deja la
 * orden en 'cancelled' mientras el dinero sigue camino al destino.
 */
export const BRIDGE_CANCELLABLE_STATE = 'awaiting_funds';

const FIAT_IN_BO_FLOWS = [
  'bolivia_to_world',
  'bolivia_to_wallet',
  'world_to_bolivia',
  'fiat_bo_to_bridge_wallet',
] as const;

/**
 * Flujos donde el cliente deposita en una cuenta PSAV: son los que tienen plazo
 * de depósito con cancelación automática (payment_orders.deposit_expires_at).
 */
export const PSAV_DEPOSIT_FLOWS: readonly string[] = FIAT_IN_BO_FLOWS;

const CRYPTO_IN_FLOWS = [
  'wallet_to_wallet',
  'wallet_to_world',
  'crypto_to_bridge_wallet',
] as const;

const WALLET_RAMP_OUT_FLOWS = [
  'bridge_wallet_to_fiat_bo',
  'bridge_wallet_to_crypto',
  'bridge_wallet_to_fiat_us',
] as const;

/**
 * Estados en los que el cliente puede cancelar, por grupo.
 *
 * Para wallet_ramp_out la lista solo contiene 'pending_review'. 'created' sigue
 * excluido a propósito: existe apenas los milisegundos entre el INSERT y la
 * respuesta de Bridge, y cancelar en esa ventana puede pisar un transfer que ya
 * salió. 'pending_review', en cambio, es la única ventana provablemente segura:
 * el expediente espera a un humano y NO existe ningún transfer en Bridge, así
 * que no hay nada que pisar — solo una reserva de saldo que se libera.
 */
const CLIENT_CANCELLABLE_STATUSES: Record<CancellationGroup, string[]> = {
  fiat_in_bo: ['created', 'waiting_deposit'],
  crypto_in: ['created', 'pending_review', 'waiting_deposit'],
  wallet_ramp_out: ['pending_review'],
};

/**
 * El staff sí puede cancelar con los fondos en tránsito (tiene contexto para
 * conciliar), pero no una vez enviado o completado: ahí el reverso es operativo,
 * no de sistema.
 */
const STAFF_CANCELLABLE_STATUSES = [
  'created',
  'pending',
  'pending_review',
  'waiting_deposit',
  'deposit_received',
  'processing',
];

export function resolveCancellationGroup(
  flowType: string | null | undefined,
): CancellationGroup | null {
  if (!flowType) return null;
  if ((FIAT_IN_BO_FLOWS as readonly string[]).includes(flowType)) {
    return 'fiat_in_bo';
  }
  if ((CRYPTO_IN_FLOWS as readonly string[]).includes(flowType)) {
    return 'crypto_in';
  }
  if ((WALLET_RAMP_OUT_FLOWS as readonly string[]).includes(flowType)) {
    return 'wallet_ramp_out';
  }
  return null;
}

/** ¿El grupo exige que el cliente declare que todavía no depositó? */
export function requiresNoDepositDeclaration(
  flowType: string | null | undefined,
): boolean {
  return resolveCancellationGroup(flowType) === 'fiat_in_bo';
}

/**
 * ¿Hay que consultar el estado del transfer en Bridge antes de cancelar?
 * Solo en los flujos donde el cliente envía cripto a una dirección de Bridge.
 */
export function requiresBridgeStateCheck(
  flowType: string | null | undefined,
): boolean {
  return resolveCancellationGroup(flowType) === 'crypto_in';
}

export interface ClientCancellationInput {
  flow_type: string | null | undefined;
  status: string;
  /**
   * Estado del transfer en Bridge. `undefined` = todavía no se consultó,
   * `null` = la orden no tiene transfer asociado.
   */
  bridge_state?: string | null;
  /** Declaración explícita del cliente de que aún no realizó el depósito. */
  confirm_no_deposit?: boolean;
}

/**
 * Decisión de cancelación para el cliente.
 *
 * Se usa en dos momentos con distinto nivel de información:
 *   1. Al serializar la orden (`can_cancel`), sin `bridge_state` consultado en
 *      vivo — devuelve la mejor decisión posible con lo que hay en base.
 *   2. Dentro de `cancelOrder`, ya con el estado fresco de Bridge y la
 *      declaración del DTO.
 */
export function evaluateClientCancellation(
  input: ClientCancellationInput,
): CancellationDecision {
  const group = resolveCancellationGroup(input.flow_type);

  if ((TERMINAL_ORDER_STATUSES as readonly string[]).includes(input.status)) {
    return {
      allowed: false,
      reason_code: 'TERMINAL_STATUS',
      message: `El expediente ya está en estado "${input.status}" y no admite cancelación.`,
    };
  }

  // Flujo desconocido o no gobernado (p. ej. va_deposit): por seguridad, no
  // cancelable por el cliente. Si aparece un flujo nuevo, hay que declararlo
  // aquí explícitamente antes de habilitarle cancelación.
  if (!group) {
    return {
      allowed: false,
      reason_code: 'FLOW_NOT_CANCELLABLE',
      message:
        'Este tipo de expediente no puede cancelarse desde la aplicación. Contacta a soporte.',
    };
  }

  // Los off-ramp de wallet mueven fondos del saldo del cliente al crearse, así
  // que como regla no se cancelan. La excepción es 'pending_review': ahí el
  // expediente todavía no generó ningún transfer en Bridge y solo hay una
  // reserva de saldo, que se devuelve al cancelar.
  if (group === 'wallet_ramp_out' && input.status !== 'pending_review') {
    return {
      allowed: false,
      reason_code: 'FLOW_NOT_CANCELLABLE',
      message:
        'Este expediente mueve fondos desde tu saldo en el momento de crearse, por lo que no puede cancelarse. Contacta a soporte si necesitas revertirlo.',
    };
  }

  if (!CLIENT_CANCELLABLE_STATUSES[group].includes(input.status)) {
    return {
      allowed: false,
      reason_code: 'STATUS_NOT_CANCELLABLE',
      message: `Ya no es posible cancelar: el expediente está en estado "${input.status}".`,
    };
  }

  if (group === 'crypto_in' && input.bridge_state !== undefined) {
    // bridge_state null = todavía no hay transfer creado en Bridge: no hay
    // fondos en juego, la cancelación es segura.
    if (
      input.bridge_state !== null &&
      input.bridge_state !== BRIDGE_CANCELLABLE_STATE
    ) {
      return {
        allowed: false,
        reason_code: 'FUNDS_IN_FLIGHT',
        message:
          'Tus fondos ya fueron recibidos por el proveedor y el expediente continuará su curso normal. Si necesitas revertirlo, contacta a soporte.',
      };
    }
  }

  if (group === 'fiat_in_bo' && input.confirm_no_deposit !== undefined) {
    if (input.confirm_no_deposit !== true) {
      return {
        allowed: false,
        reason_code: 'DEPOSIT_DECLARATION_REQUIRED',
        message:
          'Para cancelar debes confirmar que todavía no realizaste el depósito.',
      };
    }
  }

  return { allowed: true, reason_code: null, message: null };
}

/** Decisión de cancelación para el staff (panel de operaciones). */
export function evaluateStaffCancellation(
  status: string,
): CancellationDecision {
  if ((TERMINAL_ORDER_STATUSES as readonly string[]).includes(status)) {
    return {
      allowed: false,
      reason_code: 'TERMINAL_STATUS',
      message: `No se puede cancelar un expediente en estado terminal "${status}".`,
    };
  }

  if (!STAFF_CANCELLABLE_STATUSES.includes(status)) {
    return {
      allowed: false,
      reason_code: 'STATUS_NOT_CANCELLABLE',
      message: `No se puede cancelar un expediente en estado "${status}": los fondos ya salieron hacia el destino.`,
    };
  }

  return { allowed: true, reason_code: null, message: null };
}

/**
 * Texto que queda en payment_orders.cancellation_reason cuando el cliente no
 * escribe un motivo propio. Deja constancia de bajo qué condición se autorizó.
 */
export function defaultClientCancellationReason(
  flowType: string | null | undefined,
): string {
  const group = resolveCancellationGroup(flowType);
  if (group === 'fiat_in_bo') {
    return 'Cliente declaró no haber depositado';
  }
  if (group === 'crypto_in') {
    return 'Cancelado por el cliente antes de recibir fondos';
  }
  return 'Cancelado por el cliente';
}

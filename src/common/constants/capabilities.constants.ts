/**
 * capabilities.constants.ts
 *
 * Catálogo de permisos para el acceso vinculado (equipo interno de una
 * cuenta y, más adelante, contador externo).
 *
 * Tres propiedades que este archivo debe conservar siempre:
 *
 * 1) TODOS los permisos son de LECTURA. No existe ni debe existir aquí un
 *    valor que conceda crear, modificar o cancelar un expediente, dar de
 *    alta cuentas bancarias o tocar configuración. Esa garantía es la que
 *    hace que un miembro de equipo no pueda mover dinero bajo ninguna
 *    combinación de permisos. El día que se añada el primer permiso de
 *    escritura hace falta una revisión de seguridad propia — no basta con
 *    agregar una entrada más.
 *
 * 2) Es una LISTA BLANCA cerrada. Lo que llegue del frontend se valida
 *    contra ella y la petición entera se rechaza si aparece cualquier
 *    valor desconocido. Nunca se persiste lo que mandó el cliente sin
 *    validar.
 *
 * 3) Cada endpoint se protege con EXACTAMENTE UN permiso (ver
 *    RequiresCapability). Si un endpoint dependiera de dos, los permisos
 *    dejarían de ser independientes y habría que probar combinaciones en
 *    vez de permisos sueltos: 2^n casos en lugar de n.
 */

export const CAPABILITIES = [
  /** Expedientes: listado y detalle. Piso obligatorio de todo vínculo. */
  'orders:read',
  /** Actividad e historial de la cuenta. */
  'activity:read',
  /** Saldos y wallets. */
  'balances:read',
  /** Beneficiarios / proveedores dados de alta por el titular. */
  'suppliers:read',
  /** Estado del KYB. Nunca los documentos de identidad. */
  'compliance:read',
  /** Abrir y descargar los adjuntos de un expediente. */
  'orders:documents',
  /** Ver los datos bancarios sin enmascarar. Sensibilidad muy alta. */
  'bank_details:full',
  /** Exportar o descargar información en bloque. Sensibilidad muy alta. */
  'reports:export',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Permiso que todo vínculo tiene siempre. El resto no tiene sentido sin
 * él: no se llega a un documento ni a un importe sin poder abrir el
 * expediente que los contiene. Hacerlo obligatorio evita tener que
 * razonar sobre estados incoherentes.
 */
export const BASE_CAPABILITY: Capability = 'orders:read';

/**
 * Permisos que NO vienen en ninguna plantilla y hay que conceder a mano.
 * Es la diferencia entre «marqué la plantilla que sonaba bien» y «decidí
 * darle esto a esta persona».
 */
export const HIGH_SENSITIVITY_CAPABILITIES: readonly Capability[] = [
  'bank_details:full',
  'reports:export',
];

/** Plantillas que se ofrecen al invitar. `custom` la arma el titular. */
export const PRESETS = ['operations', 'finance', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];

/**
 * Qué permisos trae cada plantilla. `custom` no tiene entrada: sus
 * permisos llegan en la petición y se validan uno a uno.
 *
 * Ojo al cambiar esto: los vínculos ya creados NO se ven afectados,
 * porque lo concedido quedó escrito en la columna `capabilities`. Un
 * permiso nunca se amplía por editar este mapa.
 */
export const PRESET_CAPABILITIES: Record<
  Exclude<Preset, 'custom'>,
  readonly Capability[]
> = {
  operations: ['orders:read', 'activity:read'],
  finance: [
    'orders:read',
    'activity:read',
    'balances:read',
    'suppliers:read',
    'compliance:read',
    'orders:documents',
  ],
};

/** Etiquetas en castellano para correos y auditoría. */
export const PRESET_LABELS: Record<Preset, string> = {
  operations: 'Seguimiento',
  finance: 'Financiero',
  custom: 'Personalizado',
};

export const CAPABILITY_LABELS: Record<Capability, string> = {
  'orders:read': 'Ver expedientes',
  'activity:read': 'Ver actividad e historial',
  'balances:read': 'Ver saldos',
  'suppliers:read': 'Ver beneficiarios',
  'compliance:read': 'Ver estado de cumplimiento',
  'orders:documents': 'Abrir documentos adjuntos',
  'bank_details:full': 'Ver datos bancarios completos',
  'reports:export': 'Exportar información',
};

/** Type guard contra la lista blanca. */
export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === 'string' && CAPABILITIES.includes(value as Capability)
  );
}

/**
 * Resuelve los permisos efectivos de una invitación.
 *
 * - Con plantilla: se ignora lo que mande el cliente y se usa el mapa.
 *   Que el frontend no pueda «ajustar» una plantilla por debajo evita que
 *   la etiqueta guardada mienta sobre los permisos reales.
 * - Con `custom`: se usan los permisos recibidos, ya validados por el DTO.
 *
 * En ambos casos se garantiza el permiso base y se eliminan duplicados.
 */
export function resolveCapabilities(
  preset: Preset,
  requested: Capability[] = [],
): Capability[] {
  const base =
    preset === 'custom' ? requested : [...PRESET_CAPABILITIES[preset]];

  return Array.from(new Set<Capability>([BASE_CAPABILITY, ...base]));
}

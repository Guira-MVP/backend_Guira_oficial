/**
 * Formateo de fechas en hora de Bolivia (UTC-4).
 *
 * IMPORTANTE: los timestamps se ALMACENAN en UTC (columnas `timestamptz`).
 * Estas funciones solo afectan la PRESENTACIÓN. El proceso Node corre en UTC
 * (Render), por eso `toLocaleString` sin `timeZone` imprimía UTC. Fijar
 * `timeZone: BOLIVIA_TZ` garantiza que comprobantes y reportes muestren la
 * hora local de Bolivia sin depender del huso horario del servidor.
 */
export const BOLIVIA_TZ = 'America/La_Paz';

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
};

/**
 * Formatea un instante (ISO string / epoch / Date) en hora de Bolivia.
 * @param value  Valor a formatear. Si es vacío devuelve `fallback`.
 * @param options Opciones de Intl.DateTimeFormat (sin `timeZone`, se inyecta).
 * @param fallback Texto a devolver si el valor es nulo/vacío/ inválido.
 */
export function formatBoliviaDateTime(
  value: string | number | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = DEFAULT_OPTIONS,
  fallback = 'N/D',
): string {
  if (value === null || value === undefined || value === '') return fallback;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return typeof value === 'string' ? value : fallback;
  }
  return d.toLocaleString('es-BO', { timeZone: BOLIVIA_TZ, ...options });
}

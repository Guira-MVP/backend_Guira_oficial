/**
 * Política de muestreo de trazas para Sentry.
 *
 * Vive fuera de instrument.ts por dos razones: instrument.ts se ejecuta antes
 * que cualquier otro import de la app y no debe arrastrar dependencias, y una
 * función pura se puede testear sin levantar Nest ni el SDK.
 *
 * Motivación (medido el 22-ago-2026 en Render):
 * el backend de producción emitía ~33 MB/h de forma constante, con 0-3
 * peticiones HTTP por hora. Con tracesSampleRate: 1.0 cada tick de cron se
 * traza entera —unos 43 spans por ciclo del sincronizador de tasas— y arrastra
 * además un perfil de CPU. Los crons no paran nunca, así que la telemetría
 * tampoco.
 *
 * El reparto de abajo mantiene visibilidad completa donde el volumen es bajo y
 * el valor diagnóstico alto (peticiones de usuario, webhooks entrantes de
 * Bridge) y recorta el trabajo de fondo repetitivo, que es el que genera el
 * gasto sin aportar información nueva.
 *
 * No afecta al reporte de errores: captureException se rige por `sampleRate`,
 * que es una opción distinta y sigue en su valor por defecto (1.0). Tampoco
 * afecta a los logs (enableLogs), las métricas (enableMetrics) ni a los
 * check-ins de Cron Monitoring, que no son spans.
 */

/** Tasas por tipo de transacción. Exportadas para que el test las use. */
export const SENTRY_TRACE_RATES = {
  /**
   * Peticiones HTTP entrantes: rutas de usuario y webhooks de Bridge.
   * Volumen bajo (0-3/hora medidas en producción) y es donde de verdad se
   * quiere una traza cuando algo falla, así que van al 100%.
   */
  httpServer: 1.0,

  /**
   * Worker de webhooks: corre cada 30 s (2.880 ticks/día) y la mayoría de las
   * veces no encuentra nada que procesar. Mueve dinero, así que conviene
   * conservar una muestra en vez de apagarlo del todo.
   */
  webhookProcessor: 0.05,

  /**
   * Resto del trabajo de fondo, dominado por el cron de tasas (1.440
   * ciclos/día). Es el origen del consumo y el que menos aporta: cada ciclo es
   * idéntico al anterior.
   */
  background: 0.01,
} as const;

/**
 * Forma mínima del contexto que pasa Sentry. Se declara aquí en lugar de
 * importar el tipo del SDK para que el módulo no dependa de él.
 */
export interface TraceSamplingContext {
  name?: string;
  attributes?: Record<string, unknown>;
  parentSampled?: boolean;
}

const HTTP_METHOD_PREFIX = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/i;

/** Identifica el worker de webhooks por el `name` que le da @Cron. */
const WEBHOOK_PROCESSOR = /process[-_]?webhooks/i;

function isHttpServerTransaction(ctx: TraceSamplingContext): boolean {
  // La señal fiable es el atributo op que pone la instrumentación HTTP.
  if (ctx.attributes?.['sentry.op'] === 'http.server') return true;

  // Respaldo por nombre: Sentry nombra las transacciones HTTP "GET /ruta".
  // Cubre el caso de que una versión del SDK no rellene el atributo.
  return HTTP_METHOD_PREFIX.test(ctx.name ?? '');
}

/**
 * Decide qué fracción de trazas se envía para una transacción dada.
 *
 * El orden importa: primero se respeta una decisión heredada de un servicio
 * anterior (trazado distribuido), luego HTTP, luego el worker de webhooks, y
 * lo que no encaje cae en `background`. Ese default es deliberado: cualquier
 * transacción nueva sin clasificar es, por definición, trabajo de fondo, y
 * conviene que entre muestreada en lugar de al 100%.
 */
export function sentryTracesSampler(ctx: TraceSamplingContext): number {
  // Trazado distribuido: si un servicio anterior ya decidió, se respeta para
  // no partir la traza por la mitad. Los crons no tienen padre, así que esta
  // rama no les afecta.
  if (ctx.parentSampled === true) return 1;
  if (ctx.parentSampled === false) return 0;

  if (isHttpServerTransaction(ctx)) return SENTRY_TRACE_RATES.httpServer;

  if (WEBHOOK_PROCESSOR.test(ctx.name ?? '')) {
    return SENTRY_TRACE_RATES.webhookProcessor;
  }

  return SENTRY_TRACE_RATES.background;
}

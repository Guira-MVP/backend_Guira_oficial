// Sentry debe inicializarse ANTES que cualquier otro import de la app
// (parchea módulos de Node como http/console). Por eso main.ts lo
// importa como su primerísima línea.
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import * as dotenv from 'dotenv';
import { resolveAppEnv } from './core/config/app/app-env';
import { sentryTracesSampler } from './core/logging/sentry-sampling';

// Este archivo se ejecuta antes de que CoreConfigModule cargue .env.local,
// así que necesitamos leer el env file nosotros mismos para que SENTRY_DSN
// ya esté en process.env cuando Sentry.init() se llame.
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: '.env.local' });
}

const appEnv = resolveAppEnv();

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: appEnv,

  integrations: [
    Sentry.consoleLoggingIntegration(),
    nodeProfilingIntegration(),
  ],

  // Captura structured logs (Sentry.logger.*) y console.error/warn como logs
  // dentro de Sentry, para poder monitorear logs además de excepciones.
  enableLogs: true,

  // Métricas custom (Sentry.metrics.count/gauge/distribution).
  enableMetrics: true,

  // Tracing por tipo de transacción en lugar de una tasa global. El detalle
  // de las tasas y el porqué de cada una está en sentry-sampling.ts.
  //
  // Sustituye a tracesSampleRate: 1.0, que trazaba entero cada tick de cron
  // —1.440 ciclos diarios del sincronizador de tasas, ~43 spans cada uno— y
  // era el origen de ~30 MB/h de egress constante en producción.
  //
  // Solo afecta al performance monitoring. Los errores (captureException) se
  // rigen por `sampleRate`, que sigue en su valor por defecto de 1.0.
  tracesSampler: sentryTracesSampler,

  // Profiling: se activa automáticamente durante los traces activos.
  //
  // Se deja en 1.0 a propósito. Con profileLifecycle: 'trace' el perfilador
  // solo corre mientras hay un span raíz muestreado, así que el recorte del
  // tracesSampler ya arrastra el perfilado en la misma proporción, de forma
  // suave y predecible.
  //
  // Bajar este valor NO es el siguiente paso obvio: en el SDK v10 se evalúa
  // una sola vez al arrancar el proceso, no por traza. Ponerlo a 0.1 con una
  // única instancia significa que ~90% de los despliegues no perfilarían nada
  // y ~10% perfilarían igual que hoy — consumo a saltos entre deploys. Si hace
  // falta recortar más, la opción determinista es 0 (perfilado desactivado).
  profileSessionSampleRate: 1.0,
  profileLifecycle: 'trace',

  // No enviar por defecto cookies/headers/bodies — el backend maneja datos
  // financieros (KYB, cuentas Bridge). Se scrubbea manualmente en beforeSend
  // lo poco que sí necesitamos (nombre de header, no su valor).
  dataCollection: {
    // userInfo: false,
    // httpBodies: [],
  },

  beforeSend(event) {
    // Redacta el header Authorization (JWT de Supabase) si llegara a colarse
    // en el contexto de una request capturada.
    if (event.request?.headers?.['Authorization']) {
      event.request.headers['Authorization'] = '[Filtered]';
    }
    if (event.request?.headers?.['authorization']) {
      event.request.headers['authorization'] = '[Filtered]';
    }
    return event;
  },
});

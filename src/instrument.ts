// Sentry debe inicializarse ANTES que cualquier otro import de la app
// (parchea módulos de Node como http/console). Por eso main.ts lo
// importa como su primerísima línea.
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import * as dotenv from 'dotenv';
import { resolveAppEnv } from './core/config/app/app-env';

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

  // Tracing: 100% de las transacciones (requests HTTP, jobs, etc.).
  tracesSampleRate: 1.0,

  // Profiling: se activa automáticamente durante los traces activos.
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

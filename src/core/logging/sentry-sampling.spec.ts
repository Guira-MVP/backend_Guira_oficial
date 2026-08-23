import {
  sentryTracesSampler,
  SENTRY_TRACE_RATES,
  type TraceSamplingContext,
} from './sentry-sampling';

describe('sentryTracesSampler', () => {
  describe('peticiones HTTP entrantes', () => {
    it('traza al 100% cuando el SDK marca la transacción como http.server', () => {
      const ctx: TraceSamplingContext = {
        name: 'GET /api/health',
        attributes: { 'sentry.op': 'http.server' },
      };

      expect(sentryTracesSampler(ctx)).toBe(SENTRY_TRACE_RATES.httpServer);
    });

    it('reconoce la transacción por el nombre si falta el atributo op', () => {
      // Respaldo para versiones del SDK que no rellenen 'sentry.op'.
      const ctx: TraceSamplingContext = { name: 'POST /webhooks/bridge' };

      expect(sentryTracesSampler(ctx)).toBe(SENTRY_TRACE_RATES.httpServer);
    });

    it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])(
      'cubre el método %s',
      (method) => {
        expect(sentryTracesSampler({ name: `${method} /api/orders` })).toBe(
          SENTRY_TRACE_RATES.httpServer,
        );
      },
    );

    it('no confunde un nombre que solo empieza por letras de un método', () => {
      // 'GETting...' no es una transacción HTTP: el regex exige separador.
      expect(sentryTracesSampler({ name: 'GETtingRatesJob' })).toBe(
        SENTRY_TRACE_RATES.background,
      );
    });
  });

  describe('worker de webhooks', () => {
    it('conserva una muestra del procesador de webhooks', () => {
      const ctx: TraceSamplingContext = { name: 'process-webhooks' };

      expect(sentryTracesSampler(ctx)).toBe(
        SENTRY_TRACE_RATES.webhookProcessor,
      );
    });

    it('lo reconoce aunque el nombre venga con prefijo o en camelCase', () => {
      expect(sentryTracesSampler({ name: 'Cron process-webhooks' })).toBe(
        SENTRY_TRACE_RATES.webhookProcessor,
      );
      expect(
        sentryTracesSampler({ name: 'WebhooksService.processWebhooks' }),
      ).toBe(SENTRY_TRACE_RATES.webhookProcessor);
    });
  });

  describe('trabajo de fondo', () => {
    it('muestrea al mínimo el cron de sincronización de tasas', () => {
      // Es el origen del consumo: 1.440 ciclos/día, todos idénticos.
      const ctx: TraceSamplingContext = {
        name: 'ExchangeRatesService.handleCronSyncRates',
      };

      expect(sentryTracesSampler(ctx)).toBe(SENTRY_TRACE_RATES.background);
    });

    it('cae en background cualquier transacción sin clasificar', () => {
      expect(sentryTracesSampler({ name: 'algo-nuevo-sin-clasificar' })).toBe(
        SENTRY_TRACE_RATES.background,
      );
    });

    it('cae en background si no llega nombre ni atributos', () => {
      expect(sentryTracesSampler({})).toBe(SENTRY_TRACE_RATES.background);
    });
  });

  describe('trazado distribuido', () => {
    it('respeta la decisión afirmativa del servicio anterior', () => {
      const ctx: TraceSamplingContext = {
        name: 'ExchangeRatesService.handleCronSyncRates',
        parentSampled: true,
      };

      expect(sentryTracesSampler(ctx)).toBe(1);
    });

    it('respeta la decisión negativa del servicio anterior', () => {
      const ctx: TraceSamplingContext = {
        name: 'GET /api/health',
        attributes: { 'sentry.op': 'http.server' },
        parentSampled: false,
      };

      expect(sentryTracesSampler(ctx)).toBe(0);
    });
  });

  describe('garantías de la política', () => {
    it('recorta el trabajo de fondo respecto a las peticiones de usuario', () => {
      expect(SENTRY_TRACE_RATES.background).toBeLessThan(
        SENTRY_TRACE_RATES.httpServer,
      );
      expect(SENTRY_TRACE_RATES.webhookProcessor).toBeLessThan(
        SENTRY_TRACE_RATES.httpServer,
      );
    });

    it('mantiene todas las tasas dentro del rango válido de Sentry', () => {
      for (const rate of Object.values(SENTRY_TRACE_RATES)) {
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(1);
      }
    });
  });
});

import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import { timingSafeEqual } from 'crypto';
import { AppService } from './app.service';
import { SUPABASE_CLIENT } from './core/supabase/supabase.module';
import { Public } from './core/guards/supabase-auth.guard';
import {
  AppEnv,
  isProtectedAppEnv,
  resolveAppEnv,
} from './core/config/app/app-env';

function isValidDebugToken(provided: string | undefined): boolean {
  const expected = process.env.DEBUG_SENTRY_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@ApiTags('System')
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Mensaje de bienvenida API' })
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Ventana durante la que se reutiliza el último sondeo a la base.
   *
   * Render llama a /api/health cada ~4 s y hasta ahora cada llamada consultaba
   * la base: 20.160 consultas diarias que nadie lee (medido el 29-ago-2026 en
   * los logs de Supabase, 14 GET/min a /rest/v1/profiles). Con 30 s de caché
   * bajan a ~2.880 sin perder capacidad de detección: Render necesita varios
   * sondeos fallidos consecutivos para dar la instancia por caída, así que el
   * retraso que añade este TTL queda holgadamente dentro de su propia ventana.
   */
  private static readonly DB_HEALTH_TTL_MS = 30_000;

  private dbHealth?: { reachable: boolean; checkedAt: number };

  /**
   * Sondeo en curso. El endpoint es @Public(), así que sin esto una ráfaga de
   * peticiones simultáneas se traduciría en una consulta por petición justo
   * cuando la caché aún no se ha rellenado.
   */
  private dbHealthInFlight?: Promise<boolean>;

  private async probeDatabase(): Promise<boolean> {
    let reachable: boolean;
    try {
      const { error } = await this.supabase
        .from('profiles')
        .select('id')
        .limit(1);
      reachable = !error;
    } catch {
      // Un healthcheck nunca debe responder 500: que la base sea inalcanzable
      // es justo el resultado que se quiere reportar, no un fallo del endpoint.
      reachable = false;
    }

    this.dbHealth = { reachable, checkedAt: Date.now() };
    return reachable;
  }

  private async isDatabaseReachable(): Promise<boolean> {
    const cached = this.dbHealth;
    if (
      cached &&
      Date.now() - cached.checkedAt < AppController.DB_HEALTH_TTL_MS
    ) {
      return cached.reachable;
    }

    // El resultado se cachea tanto si la base responde como si no: durante una
    // caída es cuando menos conviene multiplicar las consultas contra ella.
    this.dbHealthInFlight ??= this.probeDatabase().finally(() => {
      this.dbHealthInFlight = undefined;
    });

    return this.dbHealthInFlight;
  }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Healthcheck y estado del sistema' })
  async getHealth() {
    const databaseReachable = await this.isDatabaseReachable();

    return {
      status: databaseReachable ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '1.0.0',
      services: {
        database: databaseReachable ? 'connected' : 'unreachable',
        bridge_api: this.config.get('app.bridgeApiKey')
          ? 'configured'
          : 'not_configured',
      },
    };
  }

  @Get('debug-sentry')
  @Public()
  @ApiOperation({
    summary:
      'Prueba la integración de Sentry (en staging y producción requiere ?token=DEBUG_SENTRY_TOKEN)',
  })
  getDebugSentry(@Query('token') token?: string) {
    const appEnv = this.config.get<AppEnv>('app.appEnv') ?? resolveAppEnv();

    // En staging y producción, solo responde si el token coincide con
    // DEBUG_SENTRY_TOKEN —
    // así evitamos exponer un endpoint público que siempre lanza un error.
    if (isProtectedAppEnv(appEnv) && !isValidDebugToken(token)) {
      throw new NotFoundException();
    }

    Sentry.logger.info('User triggered test error', {
      action: 'test_error_endpoint',
    });
    Sentry.metrics.count('test_counter', 1);

    throw new Error('My first Sentry error!');
  }
}

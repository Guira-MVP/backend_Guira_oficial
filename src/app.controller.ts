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

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Healthcheck y estado del sistema' })
  async getHealth() {
    // Verificar DB
    const { error } = await this.supabase
      .from('profiles')
      .select('id')
      .limit(1);

    return {
      status: error ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '1.0.0',
      services: {
        database: error ? 'unreachable' : 'connected',
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

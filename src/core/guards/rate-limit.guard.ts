import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.module';

const RATE_LIMIT_DEFAULTS = {
  maxAttempts: 5,
  windowMinutes: 15,
  blockMinutes: 15,
};

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  private configCache: {
    value: typeof RATE_LIMIT_DEFAULTS;
    expiresAt: number;
  } | null = null;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  private async getConfig(): Promise<typeof RATE_LIMIT_DEFAULTS> {
    if (this.configCache && Date.now() < this.configCache.expiresAt) {
      return this.configCache.value;
    }

    try {
      const { data } = await this.supabase
        .from('app_settings')
        .select('key, value')
        .in('key', [
          'RATE_LIMIT_MAX_ATTEMPTS',
          'RATE_LIMIT_WINDOW_MINUTES',
          'RATE_LIMIT_BLOCK_MINUTES',
        ]);

      const map = Object.fromEntries(
        (data ?? []).map((r) => [r.key, Number(r.value)]),
      );

      const config = {
        maxAttempts:
          map['RATE_LIMIT_MAX_ATTEMPTS'] ?? RATE_LIMIT_DEFAULTS.maxAttempts,
        windowMinutes:
          map['RATE_LIMIT_WINDOW_MINUTES'] ??
          RATE_LIMIT_DEFAULTS.windowMinutes,
        blockMinutes:
          map['RATE_LIMIT_BLOCK_MINUTES'] ?? RATE_LIMIT_DEFAULTS.blockMinutes,
      };

      this.configCache = { value: config, expiresAt: Date.now() + 60_000 };
      return config;
    } catch {
      this.logger.warn(
        'No se pudo leer config de rate limit desde app_settings, usando valores por defecto',
      );
      return RATE_LIMIT_DEFAULTS;
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const identifier = this.getIdentifier(request);
    const action = this.getAction(request);
    const config = await this.getConfig();

    const { data: existing } = await this.supabase
      .from('auth_rate_limits')
      .select('*')
      .eq('identifier', identifier)
      .eq('action', action)
      .single();

    if (existing) {
      if (
        existing.blocked_until &&
        new Date(existing.blocked_until) > new Date()
      ) {
        const remainingMs =
          new Date(existing.blocked_until).getTime() - Date.now();
        const remainingMin = Math.ceil(remainingMs / 60000);

        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Demasiados intentos. Intenta de nuevo en ${remainingMin} minuto(s).`,
            retryAfter: remainingMin,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const windowStart = new Date(
        Date.now() - config.windowMinutes * 60 * 1000,
      );
      if (new Date(existing.first_attempt_at) < windowStart) {
        await this.supabase
          .from('auth_rate_limits')
          .update({
            attempt_count: 1,
            first_attempt_at: new Date().toISOString(),
            last_attempt_at: new Date().toISOString(),
            blocked_until: null,
          })
          .eq('id', existing.id);

        return true;
      }

      const newCount = (existing.attempt_count ?? 0) + 1;
      const updatePayload: Record<string, unknown> = {
        attempt_count: newCount,
        last_attempt_at: new Date().toISOString(),
      };

      if (newCount >= config.maxAttempts) {
        updatePayload.blocked_until = new Date(
          Date.now() + config.blockMinutes * 60 * 1000,
        ).toISOString();

        this.logger.warn(
          `Rate limit excedido para ${identifier} en acción ${action}`,
        );
      }

      await this.supabase
        .from('auth_rate_limits')
        .update(updatePayload)
        .eq('id', existing.id);

      if (newCount >= config.maxAttempts) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Demasiados intentos. Intenta de nuevo en ${config.blockMinutes} minuto(s).`,
            retryAfter: config.blockMinutes,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } else {
      await this.supabase.from('auth_rate_limits').insert({
        identifier,
        identifier_type: 'ip',
        action,
        attempt_count: 1,
        first_attempt_at: new Date().toISOString(),
        last_attempt_at: new Date().toISOString(),
      });
    }

    return true;
  }

  private getIdentifier(request: Record<string, unknown>): string {
    // ALTO-01: Con 'trust proxy' habilitado en main.ts, request.ip es la IP
    // real del cliente derivada de forma segura por Express. No se lee
    // X-Forwarded-For directamente porque el cliente podría spoofearlo para
    // evadir el rate limit usando una IP distinta en cada intento.
    return (request.ip as string) ?? 'unknown';
  }

  private getAction(request: Record<string, unknown>): string {
    const url = request.url as string;
    if (url?.includes('register')) return 'register';
    if (url?.includes('refresh')) return 'refresh';
    if (url?.includes('login')) return 'login';
    if (url?.includes('forgot-password')) return 'forgot_password';
    if (url?.includes('reset-password')) return 'reset_password';
    return 'auth_generic';
  }
}

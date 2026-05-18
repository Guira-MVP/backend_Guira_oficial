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

/**
 * Configuración del rate limiter.
 * - maxAttempts: intentos permitidos en la ventana
 * - windowMinutes: tamaño de la ventana en minutos
 * - blockMinutes: tiempo de bloqueo tras exceder el límite
 */
const RATE_LIMIT_CONFIG = {
  maxAttempts: 5,
  windowMinutes: 15,
  blockMinutes: 15,
};

/**
 * Guard que implementa rate limiting basado en la tabla `auth_rate_limits`.
 * Se aplica manualmente en rutas sensibles como registro y refresh.
 *
 * Uso en controller:
 *   @UseGuards(RateLimitGuard)
 *   @Post('register')
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const identifier = this.getIdentifier(request);
    const action = this.getAction(request);

    // Verificar si ya está bloqueado
    const { data: existing } = await this.supabase
      .from('auth_rate_limits')
      .select('*')
      .eq('identifier', identifier)
      .eq('action', action)
      .single();

    if (existing) {
      // Verificar bloqueo activo
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

      // Verificar si la ventana expiró → resetear
      const windowStart = new Date(
        Date.now() - RATE_LIMIT_CONFIG.windowMinutes * 60 * 1000,
      );
      if (new Date(existing.first_attempt_at) < windowStart) {
        // Ventana expirada, resetear contador
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

      // Incrementar contador
      const newCount = (existing.attempt_count ?? 0) + 1;
      const updatePayload: Record<string, unknown> = {
        attempt_count: newCount,
        last_attempt_at: new Date().toISOString(),
      };

      // Bloquear si excede el límite
      if (newCount >= RATE_LIMIT_CONFIG.maxAttempts) {
        updatePayload.blocked_until = new Date(
          Date.now() + RATE_LIMIT_CONFIG.blockMinutes * 60 * 1000,
        ).toISOString();

        this.logger.warn(
          `Rate limit excedido para ${identifier} en acción ${action}`,
        );
      }

      await this.supabase
        .from('auth_rate_limits')
        .update(updatePayload)
        .eq('id', existing.id);

      if (newCount >= RATE_LIMIT_CONFIG.maxAttempts) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Demasiados intentos. Intenta de nuevo en ${RATE_LIMIT_CONFIG.blockMinutes} minuto(s).`,
            retryAfter: RATE_LIMIT_CONFIG.blockMinutes,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } else {
      // Primer intento: crear registro
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
    const headers = request.headers as Record<string, string | undefined>;
    return (
      headers['x-forwarded-for']?.split(',')[0]?.trim() ??
      (request.ip as string) ??
      'unknown'
    );
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

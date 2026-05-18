import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedUser } from '../guards/supabase-auth.guard';

/**
 * Extrae el usuario autenticado enriquecido del request.
 * Uso: @CurrentUser() user: AuthenticatedUser
 * Requiere que SupabaseAuthGuard esté activo.
 *
 * El objeto retornado incluye:
 * - id: UUID del usuario
 * - email: email del usuario
 * - profile: { role, onboarding_status, is_active, is_frozen, ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthenticatedUser;
  },
);

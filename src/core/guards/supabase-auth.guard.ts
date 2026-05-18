import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.module';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorador para marcar rutas como públicas (sin autenticación).
 * Uso: @Public() en el controller/handler.
 */
import { SetMetadata } from '@nestjs/common';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Interfaz que describe el usuario enriquecido adjunto a request.user
 * después de pasar por este guard.
 */
export interface AuthenticatedUser {
  /** UUID del usuario en Supabase Auth */
  id: string;
  /** Email del usuario */
  email: string;
  /** Perfil del usuario cargado desde la tabla profiles */
  profile: {
    role: 'client' | 'staff' | 'admin' | 'super_admin';
    onboarding_status: string;
    is_active: boolean;
    is_frozen: boolean;
    frozen_reason: string | null;
    bridge_customer_id: string | null;
    full_name: string | null;
  };
}

/**
 * Guard global que valida el JWT de Supabase Auth y enriquece
 * request.user con los datos del perfil (role, is_active, is_frozen).
 *
 * Bloquea automáticamente cuentas inactivas o congeladas.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Rutas públicas: skip
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'] as string | undefined;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de autenticación requerido');
    }

    const token = authHeader.split(' ')[1];

    // 1. Validar JWT con Supabase Auth
    const { data, error } = await this.supabase.auth.getUser(token);

    if (error || !data?.user) {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    const supabaseUser = data.user;

    // 2. Cargar perfil con rol y estado desde nuestra tabla profiles
    const { data: profile, error: profileError } = await this.supabase
      .from('profiles')
      .select(
        'role, onboarding_status, is_active, is_frozen, frozen_reason, bridge_customer_id, full_name',
      )
      .eq('id', supabaseUser.id)
      .single();

    if (profileError || !profile) {
      this.logger.warn(
        `Perfil no encontrado para usuario ${supabaseUser.id}: ${profileError?.message}`,
      );
      throw new UnauthorizedException(
        'Perfil de usuario no encontrado. Contacta soporte.',
      );
    }

    // 3. Bloquear cuentas inactivas
    if (!profile.is_active) {
      throw new ForbiddenException('Cuenta inactiva');
    }

    // 4. Bloquear cuentas congeladas
    if (profile.is_frozen) {
      throw new ForbiddenException(
        `Cuenta congelada: ${profile.frozen_reason ?? 'Sin motivo especificado'}`,
      );
    }

    // 5. Adjuntar user enriquecido al request
    const authenticatedUser: AuthenticatedUser = {
      id: supabaseUser.id,
      email: supabaseUser.email ?? '',
      profile: {
        role: profile.role ?? 'client',
        onboarding_status: profile.onboarding_status ?? 'pending',
        is_active: profile.is_active ?? true,
        is_frozen: profile.is_frozen ?? false,
        frozen_reason: profile.frozen_reason ?? null,
        bridge_customer_id: profile.bridge_customer_id ?? null,
        full_name: profile.full_name ?? null,
      },
    };

    request.user = authenticatedUser;
    return true;
  }
}

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
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
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
  /**
   * Perfil del usuario. Todo sale de `profiles` EXCEPTO `role`, que se
   * resuelve contra `private.staff_members`. La forma se mantiene para no
   * romper los consumidores existentes de `user.profile.role`.
   */
  profile: {
    /** Resuelto desde private.staff_members; 'client' si no es personal interno. */
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
 *
 * NOTA: Se crea un cliente Supabase efímero por cada request para validar
 * el JWT del usuario. Esto evita que el estado de sesión de un usuario
 * quede en memoria de una instancia compartida (el SDK de Supabase escribe
 * la sesión internamente aunque persistSession=false), lo que bajo
 * concurrencia podría contaminar requests de otros usuarios.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);
  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    this.supabaseUrl = this.configService.get<string>('app.supabaseUrl')!;
    this.supabaseAnonKey = this.configService.get<string>('app.supabaseAnonKey')!;
  }

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

    // 1. Validar JWT con un cliente efímero por request (NO el singleton de service_role).
    //    Un cliente nuevo por request garantiza que no hay estado de sesión compartido
    //    entre requests concurrentes de distintos usuarios.
    const ephemeralClient = createClient(this.supabaseUrl, this.supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await ephemeralClient.auth.getUser(token);

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
        `Perfil no encontrado para usuario ${supabaseUser.id}: [${profileError?.code}] ${profileError?.message}`,
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

    // 5. Resolver el rol desde private.staff_members, NO desde profiles.
    //    profiles.role dejó de ser la fuente de verdad: era escribible por
    //    el propio cliente con la anon key, lo que permitía auto-promoverse
    //    a super_admin. Ahora el rol vive en una tabla que PostgREST no
    //    expone, accesible solo con service_role vía este RPC.
    const staffRole = await this.resolveStaffRole(supabaseUser.id);

    // 6. Adjuntar user enriquecido al request
    const authenticatedUser: AuthenticatedUser = {
      id: supabaseUser.id,
      email: supabaseUser.email ?? '',
      profile: {
        role: staffRole ?? 'client',
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

  /**
   * Devuelve el rol de staff del usuario, o null si no es personal interno.
   *
   * private.staff_members no es accesible con .from() porque PostgREST no
   * expone el schema `private` — esa es precisamente la propiedad que cierra
   * el vector de escalación. Se accede mediante public.staff_get(), una
   * función SECURITY DEFINER con EXECUTE concedido solo a service_role.
   *
   * Ante cualquier error se devuelve null (degradar a cliente), nunca se
   * concede acceso por defecto.
   */
  private async resolveStaffRole(
    userId: string,
  ): Promise<AuthenticatedUser['profile']['role'] | null> {
    const { data, error } = await this.supabase.rpc('staff_get', {
      p_user_id: userId,
    });

    if (error) {
      this.logger.error(
        `No se pudo resolver el rol de staff para ${userId}: [${error.code}] ${error.message}`,
      );
      return null;
    }

    const member = Array.isArray(data) ? data[0] : data;
    if (!member || !member.is_active) return null;

    return member.role as AuthenticatedUser['profile']['role'];
  }
}

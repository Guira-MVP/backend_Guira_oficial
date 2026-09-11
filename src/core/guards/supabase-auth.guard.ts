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
/** Cabecera con la que el frontend pide actuar sobre la cuenta de otro. */
export const ACTING_FOR_HEADER = 'x-guira-acting-for';

/**
 * Contexto de acceso vinculado: la petición no consulta la cuenta de quien
 * inició sesión, sino la de un tercero que le concedió acceso de lectura.
 *
 * Nunca viaja en el JWT. Se resuelve contra la base en cada petición, que
 * es lo que hace que revocar un vínculo o recortar un permiso surta efecto
 * de inmediato en vez de esperar a que expire un token.
 */
export interface LinkedAccessContext {
  /** Cuenta cuyos datos se están consultando. */
  ownerId: string;
  /** De dónde sale el vínculo. */
  source: 'team_member';
  /** Permisos concedidos. Lo único que evalúa LinkedAccessGuard. */
  capabilities: string[];
}

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
  /**
   * Presente solo si la petición trae la cabecera de acceso vinculado y el
   * vínculo es válido. `id` y `profile` siguen siendo SIEMPRE los de quien
   * inició sesión: eso es lo que garantiza que una ruta de escritura que
   * use `@CurrentUser().id` opere sobre la cuenta propia del invitado y
   * nunca sobre la del titular.
   */
  linkedAccess: LinkedAccessContext | null;
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
      linkedAccess: null,
    };

    // 7. Acceso vinculado: solo si la petición lo pide explícitamente.
    //    Sin cabecera no se consulta nada, así que el caso normal (un
    //    titular sobre sus propios datos) no paga ningún query extra.
    const actingFor = request.headers[ACTING_FOR_HEADER] as string | undefined;
    if (actingFor) {
      authenticatedUser.linkedAccess = await this.resolveLinkedAccess(
        authenticatedUser,
        actingFor,
      );
    }

    request.user = authenticatedUser;
    return true;
  }

  /**
   * Valida que quien inició sesión pueda leer la cuenta `ownerId` y
   * devuelve los permisos concedidos.
   *
   * Cualquier fallo lanza 403 en vez de devolver null: si el frontend pide
   * un contexto que no le corresponde, el error debe ser visible y no
   * degradar silenciosamente a "ver mis propios datos" — eso mostraría a
   * la persona su propia cuenta creyendo que ve la del cliente.
   */
  private async resolveLinkedAccess(
    user: AuthenticatedUser,
    ownerId: string,
  ): Promise<LinkedAccessContext> {
    // El personal interno tiene su propio camino (RolesGuard). Dejarle usar
    // además este mecanismo sería una segunda vía de acceso a datos de
    // clientes, más difícil de auditar.
    if (user.profile.role !== 'client') {
      throw new ForbiddenException(
        'El personal interno no utiliza el acceso vinculado.',
      );
    }

    const { data: membership, error } = await this.supabase
      .from('account_members')
      .select('capabilities, expires_at')
      .eq('owner_id', ownerId)
      .eq('member_id', user.id)
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      this.logger.error(
        `No se pudo resolver el acceso vinculado de ${user.id} sobre ${ownerId}: [${error.code}] ${error.message}`,
      );
      throw new ForbiddenException('No se pudo verificar el acceso a esta cuenta.');
    }

    if (!membership) {
      throw new ForbiddenException('No tienes acceso a esta cuenta.');
    }

    // El titular no puede estar suspendido: si su cuenta está congelada, la
    // de su equipo tampoco opera. Se replican las mismas comprobaciones que
    // ya se le aplican a él en los pasos 3 y 4.
    const { data: ownerProfile } = await this.supabase
      .from('profiles')
      .select('is_active, is_frozen')
      .eq('id', ownerId)
      .single();

    if (!ownerProfile?.is_active || ownerProfile.is_frozen) {
      throw new ForbiddenException(
        'La cuenta a la que intentas acceder no está disponible.',
      );
    }

    return {
      ownerId,
      source: 'team_member',
      capabilities: (membership.capabilities as string[]) ?? [],
    };
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

import {
  Injectable,
  Inject,
  UnauthorizedException,
  NotFoundException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { LoginDto } from './dto/login.dto';
import { MeResponseDto } from './dto/auth-response.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';

/**
 * Tipos de evento de auditoría de autenticación.
 * Se registran en la tabla `auth_audit_log` y en los logs del servidor.
 */
type AuthEventType =
  | 'login_success'
  | 'login_failed'
  | 'oauth_login'
  | 'register_success'
  | 'register_duplicate'
  | 'logout'
  | 'token_refresh'
  | 'token_refresh_failed'
  | 'password_reset_request'
  | 'password_reset_success'
  | 'password_reset_failed';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // URL y anon key se leen una vez en el constructor y se reutilizan para crear
  // clientes efímeros por operación. Se evita un cliente compartido porque
  // signInWithPassword/refreshSession escriben el estado de sesión en memoria
  // del cliente aunque persistSession=false, lo que bajo concurrencia podría
  // contaminar requests de otros usuarios (ver SupabaseAuthGuard).
  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly configService: ConfigService,
  ) {
    this.supabaseUrl = this.configService.get<string>('app.supabaseUrl')!;
    this.supabaseAnonKey = this.configService.get<string>('app.supabaseAnonKey')!;
  }

  private createAuthClient(): SupabaseClient {
    return createClient(this.supabaseUrl, this.supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Auth Event Logging (Hallazgo 5: Auditoría de eventos)
  // ─────────────────────────────────────────────────────────────

  /**
   * Registra un evento de auditoría de autenticación.
   * Persiste en la tabla `auth_audit_log` y en los logs del servidor.
   * Nunca lanza excepciones — los errores se registran como warnings.
   */
  private async logAuthEvent(params: {
    event_type: AuthEventType;
    user_id?: string | null;
    email?: string | null;
    ip_address?: string | null;
    user_agent?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void> {
    const { event_type, user_id, email, ip_address, user_agent, metadata } =
      params;

    // Log estructurado al servidor siempre
    this.logger.log(
      `🔐 AUTH_EVENT: ${event_type} | user=${user_id ?? 'unknown'} | email=${email ?? 'n/a'} | ip=${ip_address ?? 'n/a'}`,
    );

    // Persistir en la tabla auth_audit_log (best-effort)
    try {
      await this.supabase.from('auth_audit_log').insert({
        event_type,
        user_id: user_id ?? null,
        email: email ?? null,
        ip_address: ip_address ?? null,
        user_agent: user_agent ?? null,
        metadata: metadata ?? null,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      // No bloqueamos el flujo de autenticación por un error de logging
      this.logger.warn(
        `Error persistiendo auth_audit_log (${event_type}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Extrae IP y User-Agent de un request Express.
   * Se usa desde el controller para pasar contexto de red al service.
   */
  extractRequestContext(request: {
    headers?: Record<string, string | string[] | undefined>;
    ip?: string;
  }): { ip_address: string; user_agent: string } {
    const headers = request.headers ?? {};
    const forwarded = headers['x-forwarded-for'];
    const ip_address =
      (typeof forwarded === 'string'
        ? forwarded.split(',')[0]?.trim()
        : forwarded?.[0]) ??
      request.ip ??
      'unknown';
    const ua = headers['user-agent'];
    const user_agent = (typeof ua === 'string' ? ua : ua?.[0]) ?? 'unknown';
    return { ip_address, user_agent };
  }

  // ─────────────────────────────────────────────────────────────
  // Login (Hallazgo 4: Login con rate limiting + logging)
  // ─────────────────────────────────────────────────────────────

  /**
   * Autentica un usuario con email y contraseña vía Supabase Auth.
   * Este endpoint permite aplicar rate limiting, logging de intentos
   * fallidos y auditoría desde el backend.
   */
  async login(
    dto: LoginDto,
    context: { ip_address: string; user_agent: string },
  ): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user_id: string;
  }> {
    const { data, error } =
      await this.createAuthClient().auth.signInWithPassword({
        email: dto.email,
        password: dto.password,
      });

    if (error || !data.session) {
      await this.logAuthEvent({
        event_type: 'login_failed',
        email: dto.email,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        metadata: {
          error_message: error?.message ?? 'No session returned',
        },
      });

      // Mensaje genérico para evitar enumeración de usuarios
      throw new UnauthorizedException(
        'Credenciales inválidas. Verifica tu correo y contraseña.',
      );
    }

    await this.logAuthEvent({
      event_type: 'login_success',
      user_id: data.user.id,
      email: data.user.email,
      ip_address: context.ip_address,
      user_agent: context.user_agent,
    });

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in ?? 3600,
      user_id: data.user.id,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Get Me
  // ─────────────────────────────────────────────────────────────

  /**
   * Retorna el perfil completo del usuario autenticado.
   */
  async getMe(userId: string): Promise<MeResponseDto> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select(
        'id, email, full_name, role, onboarding_status, bridge_customer_id, is_active, is_frozen, phone, avatar_url, daily_limit_usd, monthly_limit_usd, created_at',
      )
      .eq('id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Perfil no encontrado');
    }

    return data as MeResponseDto;
  }

  // ─────────────────────────────────────────────────────────────
  // Refresh Token
  // ─────────────────────────────────────────────────────────────

  /**
   * Renueva la sesión usando un refresh token.
   */
  async refreshToken(
    refreshToken: string,
    context?: { ip_address: string; user_agent: string },
  ): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    const { data, error } = await this.createAuthClient().auth.refreshSession({
      refresh_token: refreshToken,
    });

    if (error || !data.session) {
      await this.logAuthEvent({
        event_type: 'token_refresh_failed',
        ip_address: context?.ip_address,
        user_agent: context?.user_agent,
        metadata: { error_message: error?.message ?? 'No session returned' },
      });

      throw new UnauthorizedException(
        'Refresh token inválido o expirado. Inicia sesión nuevamente.',
      );
    }

    await this.logAuthEvent({
      event_type: 'token_refresh',
      user_id: data.user?.id,
      email: data.user?.email,
      ip_address: context?.ip_address,
      user_agent: context?.user_agent,
    });

    return {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in ?? 3600,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Logout
  // ─────────────────────────────────────────────────────────────

  /**
   * Invalida la sesión del usuario (cierra sesión en Supabase Auth).
   */
  async logout(
    userId: string,
    context?: { ip_address: string; user_agent: string },
  ): Promise<{ message: string }> {
    const { error } = await this.supabase.auth.admin.signOut(userId);

    if (error) {
      this.logger.warn(
        `Error cerrando sesión para ${userId}: ${error.message}`,
      );
      // No lanzamos error — el token ya podría estar expirado
    }

    await this.logAuthEvent({
      event_type: 'logout',
      user_id: userId,
      ip_address: context?.ip_address,
      user_agent: context?.user_agent,
    });

    return { message: 'Sesión cerrada exitosamente' };
  }

  // ─────────────────────────────────────────────────────────────
  // Forgot Password (Hallazgo 6: ConfigService en vez de process.env)
  // ─────────────────────────────────────────────────────────────

  /**
   * Solicita el envío de un correo para restablecer la contraseña.
   */
  async forgotPassword(
    dto: ForgotPasswordDto,
    context?: { ip_address: string; user_agent: string },
  ): Promise<{ message: string }> {
    // Hallazgo 6: Usar URL_FRONTEND validada via ConfigService en vez de
    // process.env.FRONTEND_URL sin validar.
    const frontendUrl =
      this.configService.get<string>('app.urlFrontend')?.split(',')[0]?.trim() ||
      'http://localhost:3000';

    // Usamos el cliente regular (no admin) para resetPasswordForEmail
    // para que use las plantillas de email configuradas en el proyecto
    const { error } = await this.createAuthClient().auth.resetPasswordForEmail(
      dto.email,
      {
        redirectTo: `${frontendUrl}/recuperar/update`,
      },
    );

    if (error) {
      this.logger.error(
        `Error en forgot password para ${dto.email}: ${error.message}`,
      );
      // Nunca confirmamos si el email existe o no por seguridad,
      // pero si el error es de rate limit etc, lo manejamos.
      // Retornamos éxito de todas formas si no es un error de sistema crítico.
    }

    await this.logAuthEvent({
      event_type: 'password_reset_request',
      email: dto.email,
      ip_address: context?.ip_address,
      user_agent: context?.user_agent,
    });

    return {
      message:
        'Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña.',
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Reset Password
  // ─────────────────────────────────────────────────────────────

  /**
   * Restablece la contraseña de un usuario asumiendo que ya se autenticó temporalmente
   * con el token enviado a su correo electrónico.
   * Requiere el ID del usuario (extraído del token) y la nueva contraseña.
   */
  async resetPassword(
    userId: string,
    dto: ResetPasswordDto,
    context?: { ip_address: string; user_agent: string },
  ): Promise<{ message: string }> {
    // Usamos updateUser usando la sesión de supabase
    // Dado que estamos en el backend con Guards personalizados, la forma más segura
    // es usar el API admin para actualizar el usuario directamente, ya que el middleware
    // de SupabaseAuthGuard ya validó la autenticidad de la petición con el token JWT

    const { error } = await this.supabase.auth.admin.updateUserById(userId, {
      password: dto.new_password,
    });

    if (error) {
      this.logger.error(
        `Error reseteando contraseña para ${userId}: ${error.message}`,
      );

      await this.logAuthEvent({
        event_type: 'password_reset_failed',
        user_id: userId,
        ip_address: context?.ip_address,
        user_agent: context?.user_agent,
        metadata: { error_message: error.message },
      });

      throw new InternalServerErrorException(
        'No se pudo restablecer la contraseña. Intente nuevamente.',
      );
    }

    await this.logAuthEvent({
      event_type: 'password_reset_success',
      user_id: userId,
      ip_address: context?.ip_address,
      user_agent: context?.user_agent,
    });

    return { message: 'Contraseña actualizada exitosamente' };
  }

  // ─────────────────────────────────────────────────────────────
  // OAuth Callback (Corrección G1 + G3: Auditoría + perfil)
  // ─────────────────────────────────────────────────────────────

  /**
   * Registra un evento de login OAuth y asegura que el perfil del usuario
   * tenga full_name poblado (Google provee el nombre en user_metadata).
   * Este endpoint es llamado desde /auth/callback tras exchangeCodeForSession.
   */
  async oauthCallback(
    userId: string,
    provider: string,
    context: { ip_address: string; user_agent: string },
  ): Promise<{ message: string }> {
    // Registrar evento de login OAuth
    await this.logAuthEvent({
      event_type: 'oauth_login',
      user_id: userId,
      ip_address: context.ip_address,
      user_agent: context.user_agent,
      metadata: { provider },
    });

    // Corrección G3: Verificar que el perfil tenga full_name
    // Si el trigger handle_new_user no lo capturó, lo obtenemos
    // del user_metadata de Supabase Auth (Google provee 'full_name' o 'name').
    try {
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('id, full_name')
        .eq('id', userId)
        .maybeSingle();

      if (profile && !profile.full_name) {
        // Obtener nombre del metadata de Supabase Auth
        const { data: authUser } =
          await this.supabase.auth.admin.getUserById(userId);

        const fullName =
          authUser?.user?.user_metadata?.full_name ??
          authUser?.user?.user_metadata?.name ??
          authUser?.user?.email?.split('@')[0] ??
          null;

        if (fullName) {
          await this.supabase
            .from('profiles')
            .update({ full_name: fullName })
            .eq('id', userId);

          this.logger.log(
            `OAuth profile updated: ${userId} → full_name="${fullName}" (provider=${provider})`,
          );
        }
      }
    } catch (err) {
      // Best-effort: no bloqueamos el login por un error de perfil
      this.logger.warn(
        `Error actualizando perfil post-OAuth para ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { message: 'OAuth callback procesado' };
  }
}

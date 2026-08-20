import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ProfileResponseDto } from './dto/profile-response.dto';
import { AdminGateway } from '../admin/admin.gateway';

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);
  private readonly allowedAvatarExtensions = new Set([
    'png',
    'jpg',
    'jpeg',
    'webp',
  ]);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly adminGateway: AdminGateway,
    private readonly config: ConfigService,
  ) {}

  // ───────────────────────────────────────────────
  //  Endpoints para el usuario autenticado
  // ───────────────────────────────────────────────

  /**
   * Retorna el perfil completo del usuario autenticado.
   */
  /**
   * @param resolvedRole Rol ya resuelto por SupabaseAuthGuard contra
   *   private.staff_members. Se pasa explícitamente porque profiles.role dejó
   *   de ser fuente de verdad: quedó congelado en 'client' para todo el mundo,
   *   así que devolverlo tal cual haría que el panel viera a su propio
   *   personal como clientes.
   */
  async findOne(
    userId: string,
    resolvedRole?: string,
  ): Promise<ProfileResponseDto> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Perfil no encontrado');

    return {
      ...(data as ProfileResponseDto),
      ...(resolvedRole ? { role: resolvedRole } : {}),
    } as ProfileResponseDto;
  }

  /**
   * Actualiza el avatar visual del perfil del usuario (avatar_url).
   */
  async update(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<ProfileResponseDto> {
    if (dto.avatar_url) {
      this.validateAvatarUrl(dto.avatar_url, userId);
    }

    const { data, error } = await this.supabase
      .from('profiles')
      .update({
        avatar_url: dto.avatar_url,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throwDbError(error);

    // WS: notificar al staff que el perfil fue actualizado
    this.adminGateway.emitUserUpdated({
      id: data.id,
      role: data.role,
      is_active: data.is_active,
      is_frozen: data.is_frozen,
      frozen_reason: data.frozen_reason ?? null,
      onboarding_status: data.onboarding_status,
      bridge_customer_id: data.bridge_customer_id ?? null,
      updated_at: data.updated_at ?? new Date().toISOString(),
    });

    return data as ProfileResponseDto;
  }

  /**
   * Valida que avatar_url apunte al propio bucket "avatars" del proyecto,
   * dentro de la carpeta del usuario autenticado. Evita que un usuario
   * referencie URLs externas arbitrarias (tracking/SSRF) o rutas de
   * otros usuarios.
   */
  private validateAvatarUrl(avatarUrl: string, userId: string): void {
    const supabaseUrl = this.config.get<string>('app.supabaseUrl');
    const expectedPrefix = `${supabaseUrl}/storage/v1/object/public/avatars/${userId}/`;

    if (!avatarUrl.startsWith(expectedPrefix)) {
      throw new BadRequestException('avatar_url inválido');
    }
  }

  /**
   * Genera una URL firmada para subir avatar a Supabase Storage.
   */
  async getAvatarUploadUrl(
    userId: string,
    fileName: string,
  ): Promise<{ upload_url: string; path: string }> {
    const sanitizedFileName = this.sanitizeAvatarFileName(fileName);
    const path = `${userId}/${Date.now()}-${sanitizedFileName}`;
    const { data, error } = await this.supabase.storage
      .from('avatars')
      .createSignedUploadUrl(path);

    if (error) throwDbError(error);
    return { upload_url: data.signedUrl, path };
  }

  private sanitizeAvatarFileName(fileName: string): string {
    const trimmedFileName = fileName?.trim();

    if (!trimmedFileName) {
      throw new BadRequestException('Nombre de archivo inválido');
    }

    const cleanedFileName = trimmedFileName
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, '_');

    if (!cleanedFileName || cleanedFileName.startsWith('.')) {
      throw new BadRequestException('Nombre de archivo inválido');
    }

    const extension = cleanedFileName.split('.').pop()?.toLowerCase();
    if (!extension || !this.allowedAvatarExtensions.has(extension)) {
      throw new BadRequestException(
        'Formato de avatar no permitido. Usa PNG, JPG, JPEG o WEBP.',
      );
    }

    return cleanedFileName;
  }

  /**
   * Retorna un resumen del estado de onboarding del usuario.
   */
  async getOnboardingStatus(userId: string) {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('onboarding_status, bridge_customer_id')
      .eq('id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Perfil no encontrado');

    return {
      onboarding_status: data.onboarding_status,
      has_bridge_account: !!data.bridge_customer_id,
    };
  }

  /**
   * Obtiene el número de teléfono del cliente buscando en las tablas
   * people o businesses (onboarding), o como fallback en profiles.
   */
  async getClientPhone(userId: string): Promise<string | null> {
    // 1. Buscar en people
    const { data: person } = await this.supabase
      .from('people')
      .select('phone')
      .eq('user_id', userId)
      .single();
    if (person?.phone) return person.phone;

    // 2. Buscar en businesses
    const { data: business } = await this.supabase
      .from('businesses')
      .select('phone')
      .eq('user_id', userId)
      .single();
    if (business?.phone) return business.phone;

    // 3. Fallback a profiles
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('phone')
      .eq('id', userId)
      .single();
    return profile?.phone ?? null;
  }

  /**
   * Devuelve los datos de identidad del cliente para el comprobante PDF:
   * CI o NIT (persona natural), NIT (empresa), y país.
   * Busca primero en `people`, luego en `businesses`.
   */
  async getClientIdentityForPdf(userId: string): Promise<{
    identity_label: string;
    identity_value: string | null;
    country: string | null;
    is_company: boolean;
  } | null> {
    const { data: person } = await this.supabase
      .from('people')
      .select('id_number, id_type, tax_id, country, nationality')
      .eq('user_id', userId)
      .maybeSingle();

    if (person) {
      const hasTaxId = !!person.tax_id;
      return {
        identity_label: hasTaxId ? 'NIT' : 'C.I.',
        identity_value: hasTaxId ? person.tax_id : (person.id_number ?? null),
        country: person.country ?? person.nationality ?? null,
        is_company: false,
      };
    }

    const { data: business } = await this.supabase
      .from('businesses')
      .select('tax_id, country')
      .eq('user_id', userId)
      .maybeSingle();

    if (business) {
      return {
        identity_label: 'NIT',
        identity_value: business.tax_id ?? null,
        country: business.country ?? null,
        is_company: true,
      };
    }

    return null;
  }

  // ───────────────────────────────────────────────
  //  Endpoints de administración (Admin / Staff)
  // ───────────────────────────────────────────────

  /**
   * Lista todos los perfiles de forma paginada.
   * Solo accesible por admin/staff.
   */
  async findAll(
    page = 1,
    limit = 20,
    filters?: {
      role?: string;
      onboarding_status?: string;
      is_frozen?: boolean;
    },
  ) {
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from('profiles')
      .select(
        'id, email, full_name, role, onboarding_status, is_active, is_frozen, created_at, avatar_url, metadata, assigned_psav_id',
        { count: 'exact' },
      )
      .eq('onboarding_status', filters?.onboarding_status ?? 'approved')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Aplicar filtros opcionales
    if (filters?.role) {
      query = query.eq('role', filters.role);
    }
    if (filters?.is_frozen !== undefined) {
      query = query.eq('is_frozen', filters.is_frozen);
    }

    const { data, error, count } = await query;

    if (error) throwDbError(error);

    return {
      data,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / limit),
      },
    };
  }

  /**
   * Retorna el perfil completo de un usuario por su ID.
   * Solo accesible por admin/staff.
   */
  async findById(targetId: string): Promise<ProfileResponseDto> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', targetId)
      .single();

    if (error || !data)
      throw new NotFoundException(`Usuario ${targetId} no encontrado`);
    return data as ProfileResponseDto;
  }

  /**
   * Congela o descongela una cuenta de usuario.
   * Registra la acción en audit_logs.
   */
  async freezeAccount(
    targetId: string,
    freeze: boolean,
    reason: string | undefined,
    actorId: string,
    actorRole: string,
  ): Promise<ProfileResponseDto> {
    if (freeze && !reason) {
      throw new BadRequestException(
        'Se requiere un motivo para congelar la cuenta',
      );
    }

    const updatePayload: Record<string, unknown> = {
      is_frozen: freeze,
      frozen_reason: freeze ? reason : null,
      frozen_at: freeze ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from('profiles')
      .update(updatePayload)
      .eq('id', targetId)
      .select()
      .single();

    if (error || !data)
      throw new NotFoundException(`Usuario ${targetId} no encontrado`);

    // Registrar en audit_logs
    await this.supabase.from('audit_logs').insert({
      performed_by:    actorId,
      role:            actorRole,
      action:          freeze ? 'ACCOUNT_FROZEN' : 'ACCOUNT_UNFROZEN',
      table_name:      'profiles',
      record_id:       targetId,
      reason:          reason ?? null,
      previous_values: { is_frozen: !freeze },
      new_values:      { is_frozen: freeze },
      source:          'admin_panel',
    });

    // WS: notificar al staff que la cuenta fue congelada/descongelada
    this.adminGateway.emitUserUpdated({
      id: data.id,
      role: data.role,
      is_active: data.is_active,
      is_frozen: data.is_frozen,
      frozen_reason: data.frozen_reason ?? null,
      onboarding_status: data.onboarding_status,
      bridge_customer_id: data.bridge_customer_id ?? null,
      updated_at: data.updated_at ?? new Date().toISOString(),
    });

    this.logger.log(
      `Cuenta ${targetId} ${freeze ? 'congelada' : 'descongelada'} por ${actorId}`,
    );

    return data as ProfileResponseDto;
  }

  /**
   * Activa o desactiva una cuenta de usuario.
   * Registra la acción en audit_logs.
   */
  async toggleActive(
    targetId: string,
    isActive: boolean,
    actorId: string,
    actorRole: string,
  ): Promise<ProfileResponseDto> {
    const { data, error } = await this.supabase
      .from('profiles')
      .update({
        is_active: isActive,
        updated_at: new Date().toISOString(),
      })
      .eq('id', targetId)
      .select()
      .single();

    if (error || !data)
      throw new NotFoundException(`Usuario ${targetId} no encontrado`);

    // Registrar en audit_logs
    await this.supabase.from('audit_logs').insert({
      performed_by:    actorId,
      role:            actorRole,
      action:          isActive ? 'ACCOUNT_ACTIVATED' : 'ACCOUNT_DEACTIVATED',
      table_name:      'profiles',
      record_id:       targetId,
      previous_values: { is_active: !isActive },
      new_values:      { is_active: isActive },
      source:          'admin_panel',
    });

    // WS: notificar al staff que la cuenta fue activada/desactivada
    this.adminGateway.emitUserUpdated({
      id: data.id,
      role: data.role,
      is_active: data.is_active,
      is_frozen: data.is_frozen,
      frozen_reason: data.frozen_reason ?? null,
      onboarding_status: data.onboarding_status,
      bridge_customer_id: data.bridge_customer_id ?? null,
      updated_at: data.updated_at ?? new Date().toISOString(),
    });

    this.logger.log(
      `Cuenta ${targetId} ${isActive ? 'activada' : 'desactivada'} por ${actorId}`,
    );

    return data as ProfileResponseDto;
  }

  /**
   * Archiva o elimina la cuenta de un cliente.
   *
   * Portado desde la Edge Function `admin-delete-user`, que se retira: su
   * comprobación de permisos leía profiles.role, columna que dejó de ser
   * fuente de verdad del rol, y además vivía fuera de RolesGuard y de
   * audit_logs.
   *
   *  - `archive`: banea la cuenta en Supabase Auth y marca is_active=false.
   *    Es reversible con unarchiveAccount().
   *  - `delete`: borrado definitivo, permitido SOLO si no hay historial de
   *    transferencias ni órdenes. Con historial se exige archivar, para no
   *    dejar movimientos huérfanos de titular.
   */
  async archiveAccount(
    targetId: string,
    action: 'archive' | 'delete',
    reason: string,
    actor: { id: string; profile: { role: string } },
  ): Promise<{ action: 'archived' | 'deleted' }> {
    if (targetId === actor.id) {
      throw new BadRequestException(
        'No puedes archivar ni eliminar tu propia cuenta',
      );
    }

    const [transfers, orders] = await Promise.all([
      this.supabase
        .from('bridge_transfers')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', targetId),
      this.supabase
        .from('payment_orders')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', targetId),
    ]);

    if (transfers.error || orders.error) {
      throw new BadRequestException(
        'No se pudo verificar el historial del usuario',
      );
    }

    const hasHistory = (transfers.count ?? 0) > 0 || (orders.count ?? 0) > 0;

    if (action === 'delete') {
      if (hasHistory) {
        throw new BadRequestException(
          'Los usuarios con historial de transacciones deben archivarse, no eliminarse',
        );
      }

      // La auditoría se escribe ANTES del borrado: profiles.id tiene FK con
      // ON DELETE CASCADE contra auth.users, así que después ya no habría
      // registro que referenciar.
      await this.supabase.from('audit_logs').insert({
        performed_by: actor.id,
        role: actor.profile.role,
        action: 'ACCOUNT_DELETED',
        table_name: 'profiles',
        record_id: targetId,
        reason,
        source: 'admin_panel',
      });

      const { error } = await this.supabase.auth.admin.deleteUser(targetId);
      if (error) {
        throw new BadRequestException('No se pudo eliminar el usuario');
      }

      this.logger.log(`Cuenta ${targetId} eliminada por ${actor.id}`);
      return { action: 'deleted' };
    }

    // 100 años: Supabase no admite un baneo indefinido explícito.
    const { error: banError } = await this.supabase.auth.admin.updateUserById(
      targetId,
      { ban_duration: '876000h' },
    );
    if (banError) {
      throw new BadRequestException('No se pudo archivar el usuario');
    }

    const { error: profileError } = await this.supabase
      .from('profiles')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', targetId)
      .select('id')
      .single();

    if (profileError) {
      // Sin el perfil marcado, la cuenta quedaría baneada pero apareciendo
      // como activa en el panel. Se revierte el baneo.
      await this.supabase.auth.admin.updateUserById(targetId, {
        ban_duration: '0h',
      });
      throw new BadRequestException('No se pudo archivar el perfil');
    }

    await this.supabase.from('audit_logs').insert({
      performed_by: actor.id,
      role: actor.profile.role,
      action: 'ACCOUNT_ARCHIVED',
      table_name: 'profiles',
      record_id: targetId,
      new_values: { is_active: false, banned: true },
      reason,
      source: 'admin_panel',
    });

    this.logger.log(`Cuenta ${targetId} archivada por ${actor.id}`);
    return { action: 'archived' };
  }

  /**
   * Revierte un archivado: levanta el baneo y reactiva el perfil.
   * Portado desde la Edge Function `admin-unarchive-user`.
   */
  async unarchiveAccount(
    targetId: string,
    reason: string,
    actor: { id: string; profile: { role: string } },
  ): Promise<{ action: 'unarchived' }> {
    const { error: profileError } = await this.supabase
      .from('profiles')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', targetId)
      .select('id')
      .single();

    if (profileError) {
      throw new NotFoundException(`Usuario ${targetId} no encontrado`);
    }

    const { error: authError } = await this.supabase.auth.admin.updateUserById(
      targetId,
      { ban_duration: '0h' },
    );

    if (authError) {
      // Si no se puede levantar el baneo, el perfil no debe quedar como
      // activo: la persona seguiría sin poder entrar.
      await this.supabase
        .from('profiles')
        .update({ is_active: false })
        .eq('id', targetId);
      throw new BadRequestException(
        'No se pudo restaurar el acceso del usuario',
      );
    }

    await this.supabase.from('audit_logs').insert({
      performed_by: actor.id,
      role: actor.profile.role,
      action: 'ACCOUNT_UNARCHIVED',
      table_name: 'profiles',
      record_id: targetId,
      new_values: { is_active: true, banned: false },
      reason,
      source: 'admin_panel',
    });

    this.logger.log(`Cuenta ${targetId} desarchivada por ${actor.id}`);
    return { action: 'unarchived' };
  }
}

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { EmailService } from '../email/email.service';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import {
  ASSIGNABLE_STAFF_ROLES,
  AssignableStaffRole,
  InviteStaffDto,
  ResendStaffInviteDto,
  SetStaffActiveDto,
  STAFF_EMAIL_DOMAIN,
  STAFF_ROLE_LABELS,
  StaffMemberResponse,
  UpdateStaffRoleDto,
} from './dto/staff-admin.dto';

/**
 * Alta y gestión del personal interno con acceso al panel.
 *
 * Dos invariantes que esta clase existe para sostener:
 *
 *  1. Solo se admite personal del dominio corporativo. La comprobación se
 *     hace aquí y, de forma independiente, con un CHECK en la tabla: si el
 *     backend se equivocara, el INSERT falla igual.
 *
 *  2. Nadie teclea la contraseña de otra persona. Se crea la cuenta sin
 *     credencial y se envía un enlace para que su titular la defina. Así la
 *     contraseña no existe hasta ese momento, no viaja por ningún canal y
 *     quien invita no la conoce — condición necesaria para que la auditoría
 *     tenga valor de no repudio.
 *
 * El personal NO recibe cuenta en Bridge: quien quiera operar lo hace con su
 * correo personal, como cliente aparte.
 */
@Injectable()
export class StaffAdminService {
  private readonly logger = new Logger(StaffAdminService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  // ── Helpers ───────────────────────────────────────────────────────

  private get frontendUrl(): string {
    return (
      this.configService
        .get<string>('app.urlFrontend')
        ?.split(',')[0]
        ?.trim() || 'http://localhost:3000'
    );
  }

  private assertCorporateDomain(email: string): string {
    const normalized = email.trim().toLowerCase();
    if (!normalized.endsWith(STAFF_EMAIL_DOMAIN)) {
      throw new BadRequestException(
        `Solo se puede dar de alta personal con correo ${STAFF_EMAIL_DOMAIN}`,
      );
    }
    return normalized;
  }

  /**
   * Un admin no puede crear a alguien con más poder del que tiene. Misma
   * regla que ya aplicaba ProfilesService.updateRole.
   */
  private assertCanAssignRole(
    role: AssignableStaffRole,
    actor: AuthenticatedUser,
  ): void {
    if (
      (role === 'admin' || role === 'super_admin') &&
      actor.profile.role !== 'super_admin'
    ) {
      throw new BadRequestException(
        'Solo un super_admin puede asignar el rol admin o super_admin',
      );
    }
  }

  private async audit(entry: {
    actor: AuthenticatedUser;
    action: string;
    targetId: string;
    previous?: Record<string, unknown>;
    next?: Record<string, unknown>;
    reason: string;
  }): Promise<void> {
    await this.supabase.from('audit_logs').insert({
      performed_by: entry.actor.id,
      role: entry.actor.profile.role,
      action: entry.action,
      table_name: 'staff_members',
      record_id: entry.targetId,
      previous_values: entry.previous ?? null,
      new_values: entry.next ?? null,
      reason: entry.reason,
      source: 'admin_panel',
    });
  }

  /**
   * Genera el enlace con el que la persona establece su contraseña.
   *
   * Se usa `recovery` y no `invite` a propósito: la cuenta ya existe en ese
   * punto (hay que crearla antes para poder marcarla con app_metadata y para
   * satisfacer la FK de staff_members), y `invite` falla sobre usuarios ya
   * registrados. `recovery` sirve igual para la primera vez y para reenvíos.
   */
  private async generatePasswordLink(email: string): Promise<string> {
    const { data, error } = await this.supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: `${this.frontendUrl}/aceptar-invitacion` },
    });

    if (error || !data?.properties?.action_link) {
      this.logger.error(
        `No se pudo generar el enlace de acceso para ${email}: ${error?.message}`,
      );
      throw new InternalServerErrorException(
        'No se pudo generar el enlace de acceso',
      );
    }

    return data.properties.action_link;
  }

  private async sendInviteEmail(params: {
    email: string;
    fullName: string;
    role: AssignableStaffRole;
    actor: AuthenticatedUser;
  }): Promise<boolean> {
    const inviteUrl = await this.generatePasswordLink(params.email);

    return this.emailService.sendStaffInviteEmail(
      { email: params.email, name: params.fullName },
      {
        inviteUrl,
        roleLabel: STAFF_ROLE_LABELS[params.role],
        invitedByName: params.actor.profile.full_name,
      },
    );
  }

  private async findMember(id: string): Promise<StaffMemberResponse> {
    const { data, error } = await this.supabase.rpc('staff_get', {
      p_user_id: id,
    });

    if (error) {
      this.logger.error(`Error consultando staff ${id}: ${error.message}`);
      throw new InternalServerErrorException(
        'No se pudo consultar el personal',
      );
    }

    const member = Array.isArray(data) ? data[0] : data;
    if (!member) {
      throw new NotFoundException('Miembro del personal no encontrado');
    }

    return member as StaffMemberResponse;
  }

  // ── Operaciones ───────────────────────────────────────────────────

  async list(): Promise<StaffMemberResponse[]> {
    const { data, error } = await this.supabase.rpc('staff_list');

    if (error) {
      this.logger.error(`Error listando personal: ${error.message}`);
      throw new InternalServerErrorException('No se pudo listar el personal');
    }

    return (data ?? []) as StaffMemberResponse[];
  }

  async invite(
    dto: InviteStaffDto,
    actor: AuthenticatedUser,
  ): Promise<{ member: StaffMemberResponse; email_sent: boolean }> {
    const email = this.assertCorporateDomain(dto.email);
    this.assertCanAssignRole(dto.role, actor);

    // 1. Crear la cuenta en Supabase Auth SIN contraseña.
    //    `staff_invite` va en app_metadata, no en user_metadata: app_metadata
    //    solo se puede fijar con la Admin API, así que es lo que distingue una
    //    invitación legítima de un auto-registro. El trigger
    //    private.block_corporate_domain_signup() rechaza cualquier alta
    //    @guiracorp.com que no lleve esta marca.
    const { data: created, error: createError } =
      await this.supabase.auth.admin.createUser({
        email,
        email_confirm: true,
        app_metadata: { staff_invite: true },
        user_metadata: { full_name: dto.full_name },
      });

    if (createError || !created?.user) {
      // El caso habitual: la persona ya tiene cuenta (p. ej. se registró como
      // cliente con ese correo antes de existir esta restricción).
      if (createError?.message?.toLowerCase().includes('already')) {
        throw new ConflictException(
          'Ya existe una cuenta con ese correo. Revisa el listado de personal o contacta con soporte.',
        );
      }
      this.logger.error(
        `No se pudo crear la cuenta de ${email}: ${createError?.message}`,
      );
      throw new InternalServerErrorException('No se pudo crear la cuenta');
    }

    const userId = created.user.id;

    // 2. Registrar en private.staff_members (la FK exige que el usuario exista).
    const { error: inviteError } = await this.supabase.rpc('staff_invite', {
      p_id: userId,
      p_email: email,
      p_full_name: dto.full_name,
      p_role: dto.role,
      p_invited_by: actor.id,
    });

    if (inviteError) {
      // Sin fila en staff_members la cuenta no sirve para nada y además
      // bloquearía un reintento con el mismo correo. Se deshace.
      await this.supabase.auth.admin.deleteUser(userId);
      this.logger.error(
        `No se pudo registrar a ${email} como personal: ${inviteError.message}`,
      );
      throw new InternalServerErrorException(
        'No se pudo registrar al personal',
      );
    }

    // 3. Enviar el enlace para que defina su contraseña.
    const emailSent = await this.sendInviteEmail({
      email,
      fullName: dto.full_name,
      role: dto.role,
      actor,
    });

    await this.audit({
      actor,
      action: 'STAFF_INVITE',
      targetId: userId,
      next: { email, role: dto.role, full_name: dto.full_name },
      reason: dto.reason,
    });

    this.logger.log(
      `Personal invitado: ${email} con rol "${dto.role}" por ${actor.id}`,
    );

    return { member: await this.findMember(userId), email_sent: emailSent };
  }

  async resendInvite(
    id: string,
    dto: ResendStaffInviteDto,
    actor: AuthenticatedUser,
  ): Promise<{ email_sent: boolean }> {
    const member = await this.findMember(id);

    if (!member.is_active) {
      throw new BadRequestException(
        'No se puede reenviar la invitación a alguien desactivado. Reactívalo primero.',
      );
    }

    const emailSent = await this.sendInviteEmail({
      email: member.email,
      fullName: member.full_name,
      role: member.role,
      actor,
    });

    await this.audit({
      actor,
      action: 'STAFF_INVITE_RESEND',
      targetId: id,
      next: { email: member.email },
      reason: dto.reason,
    });

    return { email_sent: emailSent };
  }

  async updateRole(
    id: string,
    dto: UpdateStaffRoleDto,
    actor: AuthenticatedUser,
  ): Promise<StaffMemberResponse> {
    if (id === actor.id) {
      throw new BadRequestException('No puedes cambiar tu propio rol');
    }
    this.assertCanAssignRole(dto.role, actor);

    const member = await this.findMember(id);

    if (member.role === dto.role) {
      throw new BadRequestException(`Ya tiene el rol "${dto.role}"`);
    }

    // Degradar a un super_admin también es una operación de super_admin.
    if (member.role === 'super_admin' && actor.profile.role !== 'super_admin') {
      throw new BadRequestException(
        'Solo un super_admin puede modificar a otro super_admin',
      );
    }

    const { error } = await this.supabase.rpc('staff_update', {
      p_id: id,
      p_role: dto.role,
      p_is_active: null,
    });

    if (error) {
      this.logger.error(`Error cambiando rol de ${id}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo cambiar el rol');
    }

    await this.audit({
      actor,
      action: 'STAFF_ROLE_CHANGE',
      targetId: id,
      previous: { role: member.role },
      next: { role: dto.role },
      reason: dto.reason,
    });

    this.logger.log(
      `Rol de ${id} cambiado de "${member.role}" a "${dto.role}" por ${actor.id}`,
    );

    return this.findMember(id);
  }

  async setActive(
    id: string,
    dto: SetStaffActiveDto,
    actor: AuthenticatedUser,
  ): Promise<StaffMemberResponse> {
    if (id === actor.id) {
      throw new BadRequestException('No puedes desactivarte a ti mismo');
    }

    const member = await this.findMember(id);

    if (member.role === 'super_admin' && actor.profile.role !== 'super_admin') {
      throw new BadRequestException(
        'Solo un super_admin puede desactivar a otro super_admin',
      );
    }

    if (member.is_active === dto.is_active) {
      throw new BadRequestException(
        dto.is_active ? 'Ya está activo' : 'Ya está desactivado',
      );
    }

    const { error } = await this.supabase.rpc('staff_update', {
      p_id: id,
      p_role: null,
      p_is_active: dto.is_active,
    });

    if (error) {
      this.logger.error(`Error actualizando estado de ${id}: ${error.message}`);
      throw new InternalServerErrorException('No se pudo actualizar el estado');
    }

    // Desactivar debe cortar el acceso ya, no cuando caduque el token: se
    // revocan las sesiones abiertas. is_active se comprueba además en cada
    // request (SupabaseAuthGuard) y en cada policy RLS.
    if (!dto.is_active) {
      const { error: signOutError } = await this.supabase.auth.admin.signOut(
        id,
        'global',
      );
      if (signOutError) {
        this.logger.warn(
          `No se pudieron revocar las sesiones de ${id}: ${signOutError.message}`,
        );
      }
    }

    await this.audit({
      actor,
      action: dto.is_active ? 'STAFF_ACTIVATE' : 'STAFF_DEACTIVATE',
      targetId: id,
      previous: { is_active: member.is_active },
      next: { is_active: dto.is_active },
      reason: dto.reason,
    });

    this.logger.log(
      `Personal ${id} ${dto.is_active ? 'reactivado' : 'desactivado'} por ${actor.id}`,
    );

    return this.findMember(id);
  }

  /** Marca la primera activación. La llama el propio titular al entrar. */
  async markActivated(userId: string): Promise<void> {
    const { error } = await this.supabase.rpc('staff_mark_activated', {
      p_id: userId,
    });
    if (error) {
      this.logger.warn(
        `No se pudo marcar la activación de ${userId}: ${error.message}`,
      );
    }
  }

  /** Expuesto para los guards de onboarding: ¿este usuario es personal? */
  async isStaff(userId: string): Promise<boolean> {
    const { data, error } = await this.supabase.rpc('staff_get', {
      p_user_id: userId,
    });
    if (error) return false;
    const member = Array.isArray(data) ? data[0] : data;
    return Boolean(member?.is_active);
  }

  /** Roles asignables, para que el frontend no los duplique. */
  get assignableRoles(): readonly AssignableStaffRole[] {
    return ASSIGNABLE_STAFF_ROLES;
  }
}

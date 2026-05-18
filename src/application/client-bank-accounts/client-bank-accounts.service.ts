import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';

@Injectable()
export class ClientBankAccountsService {
  private readonly logger = new Logger(ClientBankAccountsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  // ─────────────────────────────────────────────────────
  //  Endpoints para el usuario autenticado
  // ─────────────────────────────────────────────────────

  /**
   * Registra una nueva cuenta bancaria para el usuario autenticado.
   * Solo usuarios con onboarding_status = 'approved' pueden registrar.
   * Máximo 1 cuenta BOB por usuario.
   */
  async create(userId: string, dto: CreateBankAccountDto) {
    // 1. Verificar que el usuario esté aprobado
    await this.ensureUserApproved(userId);

    // 2. Verificar que no tenga ya una cuenta BOB registrada
    const { data: existing } = await this.supabase
      .from('client_bank_accounts')
      .select('id')
      .eq('user_id', userId)
      .eq('currency', 'BOB')
      .maybeSingle();

    if (existing) {
      throw new BadRequestException(
        'Ya tienes una cuenta bancaria BOB registrada. Si necesitas cambiarla, edita la existente.',
      );
    }

    // 3. Insertar la cuenta bancaria
    const { data, error } = await this.supabase
      .from('client_bank_accounts')
      .insert({
        user_id: userId,
        bank_name: dto.bank_name.trim(),
        account_number: dto.account_number.trim(),
        account_holder: dto.account_holder.trim(),
        account_type: dto.account_type ?? 'savings',
        currency: 'BOB',
        country: 'BO',
        is_primary: true,
        is_verified: false,
        status: 'approved', // Primera creación se aprueba automáticamente
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    // 4. Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'client',
      action: 'CREATE_BANK_ACCOUNT',
      table_name: 'client_bank_accounts',
      record_id: data.id,
      new_values: {
        bank_name: dto.bank_name,
        account_number: dto.account_number,
        account_holder: dto.account_holder,
        account_type: dto.account_type ?? 'savings',
      },
      source: 'client_profile',
    });

    this.logger.log(
      `🏦 Cuenta bancaria creada: ${data.id} para usuario ${userId}`,
    );

    return data;
  }

  /**
   * Lista las cuentas bancarias del usuario autenticado.
   */
  async findByUser(userId: string) {
    const { data, error } = await this.supabase
      .from('client_bank_accounts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  /**
   * Obtiene la cuenta bancaria primaria BOB del usuario.
   * Retorna null si no tiene cuenta registrada (sin lanzar error).
   */
  async findPrimary(userId: string) {
    const { data, error } = await this.supabase
      .from('client_bank_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .eq('currency', 'BOB')
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return data ?? null;
  }

  /**
   * Solicita actualización de la cuenta bancaria.
   * Los cambios quedan en estado 'pending_approval' hasta que un staff los apruebe.
   * Límite: 1 solicitud de cambio por mes calendario.
   */
  async requestUpdate(
    userId: string,
    accountId: string,
    dto: UpdateBankAccountDto,
  ) {
    // 1. Verificar que la cuenta pertenece al usuario
    const { data: account } = await this.supabase
      .from('client_bank_accounts')
      .select('*')
      .eq('id', accountId)
      .eq('user_id', userId)
      .single();

    if (!account) {
      throw new NotFoundException('Cuenta bancaria no encontrada.');
    }

    // 2. Verificar que no haya un cambio pendiente
    if (account.status === 'pending_approval') {
      throw new BadRequestException(
        'Ya tienes una solicitud de cambio pendiente. Espera a que sea procesada.',
      );
    }

    // 3. Rate limit: 1 cambio por mes calendario
    if (account.last_change_requested_at) {
      const lastRequest = new Date(account.last_change_requested_at);
      const now = new Date();
      if (
        lastRequest.getFullYear() === now.getFullYear() &&
        lastRequest.getMonth() === now.getMonth()
      ) {
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const formattedDate = nextMonth.toLocaleDateString('es-BO', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
        throw new BadRequestException(
          `Solo puedes solicitar un cambio de cuenta bancaria por mes. Tu próximo cambio estará disponible a partir del ${formattedDate}.`,
        );
      }
    }

    // 4. Construir los cambios pendientes
    const pendingChanges: Record<string, any> = {};
    if (dto.bank_name !== undefined)
      pendingChanges.bank_name = dto.bank_name.trim();
    if (dto.account_number !== undefined)
      pendingChanges.account_number = dto.account_number.trim();
    if (dto.account_holder !== undefined)
      pendingChanges.account_holder = dto.account_holder.trim();
    if (dto.account_type !== undefined)
      pendingChanges.account_type = dto.account_type;

    if (Object.keys(pendingChanges).length === 0) {
      throw new BadRequestException(
        'No se proporcionaron cambios para actualizar.',
      );
    }

    const { data: updated, error } = await this.supabase
      .from('client_bank_accounts')
      .update({
        status: 'pending_approval',
        pending_changes: pendingChanges,
        change_reason: dto.change_reason.trim(),
        last_change_requested_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', accountId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    // 5. Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'client',
      action: 'REQUEST_BANK_ACCOUNT_UPDATE',
      table_name: 'client_bank_accounts',
      record_id: accountId,
      old_values: {
        bank_name: account.bank_name,
        account_number: account.account_number,
        account_holder: account.account_holder,
        account_type: account.account_type,
      },
      new_values: {
        ...pendingChanges,
        change_reason: dto.change_reason.trim(),
      },
      source: 'client_profile',
    });

    // 6. Notificar al usuario
    await this.supabase.from('notifications').insert({
      user_id: userId,
      type: 'info',
      title: 'Cambio de cuenta bancaria solicitado',
      message:
        'Tu solicitud de cambio de cuenta bancaria ha sido enviada. Un miembro del equipo la revisará a la brevedad.',
    });

    // 7. Notificar al staff
    await this.notifyStaff(userId);

    this.logger.log(
      `🏦 Solicitud de cambio de cuenta bancaria: ${accountId} por usuario ${userId} — Motivo: ${dto.change_reason}`,
    );

    return updated;
  }

  // Nota: El método remove() fue eliminado intencionalmente.
  // Los clientes NO pueden eliminar su cuenta bancaria, solo solicitar cambios.
  // La eliminación solo puede realizarse por staff desde el panel de administración.

  // ─────────────────────────────────────────────────────
  //  Endpoints de administración (Staff/Admin)
  // ─────────────────────────────────────────────────────

  /**
   * Ver todas las cuentas bancarias de un usuario específico (staff).
   */
  async findByUserAdmin(userId: string) {
    const { data, error } = await this.supabase
      .from('client_bank_accounts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  /**
   * Lista todas las solicitudes de cambio pendientes de aprobación.
   */
  async listPendingApprovals() {
    const { data, error } = await this.supabase
      .from('client_bank_accounts')
      .select('*, profiles!client_bank_accounts_user_id_fkey(email, full_name)')
      .eq('status', 'pending_approval')
      .order('updated_at', { ascending: true });

    if (error) {
      // Fallback sin join si la FK no existe
      const { data: fallback, error: fallbackError } = await this.supabase
        .from('client_bank_accounts')
        .select('*')
        .eq('status', 'pending_approval')
        .order('updated_at', { ascending: true });

      if (fallbackError) throw new BadRequestException(fallbackError.message);
      return fallback ?? [];
    }

    return data ?? [];
  }

  /**
   * Aprueba los cambios pendientes de una cuenta bancaria.
   */
  async approveChange(accountId: string, actorId: string) {
    const { data: account } = await this.supabase
      .from('client_bank_accounts')
      .select('*')
      .eq('id', accountId)
      .single();

    if (!account) throw new NotFoundException('Cuenta bancaria no encontrada.');
    if (account.status !== 'pending_approval') {
      throw new BadRequestException(
        'Esta cuenta no tiene cambios pendientes de aprobación.',
      );
    }

    const pendingChanges = account.pending_changes ?? {};

    // Aplicar los cambios pendientes
    const updateData: Record<string, any> = {
      status: 'approved',
      pending_changes: null,
      updated_at: new Date().toISOString(),
    };

    if (pendingChanges.bank_name)
      updateData.bank_name = pendingChanges.bank_name;
    if (pendingChanges.account_number)
      updateData.account_number = pendingChanges.account_number;
    if (pendingChanges.account_holder)
      updateData.account_holder = pendingChanges.account_holder;
    if (pendingChanges.account_type)
      updateData.account_type = pendingChanges.account_type;

    const { data: updated, error } = await this.supabase
      .from('client_bank_accounts')
      .update(updateData)
      .eq('id', accountId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    // Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'staff',
      action: 'APPROVE_BANK_ACCOUNT_CHANGE',
      table_name: 'client_bank_accounts',
      record_id: accountId,
      new_values: pendingChanges,
      source: 'admin_panel',
    });

    // Notificar al usuario
    await this.supabase.from('notifications').insert({
      user_id: account.user_id,
      type: 'success',
      title: 'Cuenta bancaria actualizada',
      message:
        'Tu solicitud de cambio de cuenta bancaria ha sido aprobada. Los nuevos datos ya están activos.',
    });

    this.logger.log(
      `✅ Cambio de cuenta bancaria aprobado: ${accountId} por staff ${actorId}`,
    );

    return updated;
  }

  /**
   * Rechaza los cambios pendientes de una cuenta bancaria.
   */
  async rejectChange(accountId: string, actorId: string, reason?: string) {
    const { data: account } = await this.supabase
      .from('client_bank_accounts')
      .select('*')
      .eq('id', accountId)
      .single();

    if (!account) throw new NotFoundException('Cuenta bancaria no encontrada.');
    if (account.status !== 'pending_approval') {
      throw new BadRequestException('Esta cuenta no tiene cambios pendientes.');
    }

    const { data: updated, error } = await this.supabase
      .from('client_bank_accounts')
      .update({
        status: 'approved', // Volver al estado aprobado original
        pending_changes: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', accountId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    // Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'staff',
      action: 'REJECT_BANK_ACCOUNT_CHANGE',
      table_name: 'client_bank_accounts',
      record_id: accountId,
      reason: reason ?? 'Sin razón especificada',
      source: 'admin_panel',
    });

    // Notificar al usuario
    await this.supabase.from('notifications').insert({
      user_id: account.user_id,
      type: 'alert',
      title: 'Cambio de cuenta bancaria rechazado',
      message: `Tu solicitud de cambio de cuenta bancaria fue rechazada. ${reason ? `Razón: ${reason}` : 'Contacta a soporte para más información.'}`,
    });

    this.logger.log(
      `❌ Cambio de cuenta bancaria rechazado: ${accountId} por staff ${actorId}`,
    );

    return updated;
  }

  // ─────────────────────────────────────────────────────
  //  Helpers
  // ─────────────────────────────────────────────────────

  /**
   * Verifica que el usuario tenga onboarding_status = 'approved'.
   */
  private async ensureUserApproved(userId: string): Promise<void> {
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('onboarding_status')
      .eq('id', userId)
      .single();

    if (!profile || profile.onboarding_status !== 'approved') {
      throw new ForbiddenException(
        'Solo puedes registrar una cuenta bancaria después de completar tu proceso de verificación (KYC/KYB).',
      );
    }
  }

  /**
   * Obtiene la cuenta bancaria activa aprobada para uso en el flujo de retiro.
   * Lanza error si no existe o no está aprobada.
   */
  async getApprovedAccountForWithdrawal(userId: string) {
    const { data: account } = await this.supabase
      .from('client_bank_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .eq('currency', 'BOB')
      .eq('status', 'approved')
      .maybeSingle();

    if (!account) {
      throw new BadRequestException(
        'Debes registrar tu cuenta bancaria en tu perfil antes de realizar un retiro a Bolivia. Ve a Perfil → Cuenta bancaria.',
      );
    }

    return account;
  }
  /**
   * Notifica al staff sobre una solicitud de cambio de cuenta bancaria.
   */
  private async notifyStaff(userId: string) {
    try {
      // Obtener el correo del usuario para mayor contexto (opcional pero bueno)
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', userId)
        .single();

      const userName = profile?.full_name || profile?.email || 'Un usuario';

      // Obtener IDs de staff/admin
      const { data: staffUsers } = await this.supabase
        .from('profiles')
        .select('id')
        .in('role', ['staff', 'admin', 'super_admin'])
        .eq('is_active', true);

      if (staffUsers && staffUsers.length > 0) {
        const notifications = staffUsers.map((s) => ({
          user_id: s.id,
          type: 'info',
          title: '🏦 Solicitud de cambio de cuenta',
          message: `${userName} ha solicitado un cambio en su cuenta bancaria. Ve al panel de usuarios para revisar.`,
          metadata: { requester_user_id: userId, tab: 'users' },
        }));

        await this.supabase.from('notifications').insert(notifications);
      }
    } catch (err) {
      this.logger.warn(`Error notificando staff sobre cambio bancario: ${err}`);
    }
  }
}

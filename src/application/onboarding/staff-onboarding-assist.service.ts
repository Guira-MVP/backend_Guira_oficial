import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { EmailService } from '../email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/notifications.dto';
import { OnboardingService } from './onboarding.service';
import { OnboardingDraftService } from './onboarding-draft.service';
import { SaveOnboardingDraftDto } from './dto/save-onboarding-draft.dto';

export interface AssistTarget {
  id: string;
  email: string | null;
  full_name: string | null;
  company_name: string | null;
  tax_id: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_id_number: string | null;
  phone: string | null;
  onboarding_status: string;
  /** Tipo declarado al registrarse (o el de su última solicitud enviada). */
  account_type: 'personal' | 'company' | null;
}

/**
 * Onboarding asistido por staff.
 *
 * El cliente le envía al staff por WhatsApp sus datos, fotos y documentos, y
 * el staff los carga en el MISMO borrador (onboarding_drafts + documentos en
 * borrador) que usaría el cliente. No se crea ni se envía ninguna solicitud
 * desde aquí: cuando el staff termina, marca el borrador como listo y el
 * cliente lo revisa, acepta los términos de Bridge (tienen que ser del
 * titular) y lo envía por el flujo normal.
 *
 * Reutiliza OnboardingDraftService y OnboardingService con el id del
 * cliente; este servicio solo agrega las comprobaciones sobre el destino y
 * la auditoría con el staff como actor.
 */
@Injectable()
export class StaffOnboardingAssistService {
  private readonly logger = new Logger(StaffOnboardingAssistService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly onboardingService: OnboardingService,
    private readonly draftService: OnboardingDraftService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  /**
   * Datos del cliente para cabecera y precarga del formulario, su borrador y
   * el estado de su última solicitud (si la hay): con la solicitud enviada o
   * en correcciones sin borrador, la pantalla no ofrece llenar el formulario.
   */
  async getContext(userId: string) {
    const target = await this.getAssistableTarget(userId);
    const [draft, applicationStatus, sameTaxIdAccounts] = await Promise.all([
      this.draftService.getDraft(userId),
      this.getLatestApplicationStatus(userId),
      this.countOtherAccountsWithTaxId(userId, target.tax_id),
    ]);
    return {
      client: target,
      draft,
      application_status: applicationStatus,
      same_tax_id_accounts: sameTaxIdAccounts,
    };
  }

  /**
   * Razón social y NIT los declara el propio cliente al registrarse y no se
   * verifican hasta el KYB. Si otra cuenta ya declaró el mismo NIT, el staff
   * lo ve antes de cargar documentos (posible suplantación o cuenta duplicada).
   */
  private async countOtherAccountsWithTaxId(
    userId: string,
    taxId: string | null,
  ): Promise<number> {
    if (!taxId) return 0;
    const { count, error } = await this.supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('tax_id', taxId)
      .neq('id', userId);
    if (error) {
      this.logger.warn(
        `No se pudo comprobar NIT duplicado de ${userId}: ${error.message}`,
      );
      return 0;
    }
    return count ?? 0;
  }

  private async getLatestApplicationStatus(
    userId: string,
  ): Promise<string | null> {
    const [kyc, kyb] = await Promise.all([
      this.supabase
        .from('kyc_applications')
        .select('status, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      this.supabase
        .from('kyb_applications')
        .select('status, created_at')
        .eq('requester_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const rows = [kyc.data, kyb.data] as Array<{
      status: string;
      created_at: string;
    } | null>;
    const latest = rows
      .filter((row): row is { status: string; created_at: string } => !!row)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return latest?.status ?? null;
  }

  async saveDraft(
    actor: AuthenticatedUser,
    userId: string,
    dto: SaveOnboardingDraftDto,
  ) {
    await this.getAssistableTarget(userId);
    const previous = await this.draftService.getDraft(userId);
    const result = await this.draftService.saveDraft(userId, dto, {
      assistedBy: actor.id,
    });

    // El autosave guarda cada pocos segundos: se audita al empezar y en cada
    // cambio de paso o de tipo, no en cada tecla. Nunca el contenido.
    if (
      !result.unchanged &&
      (!previous || previous.step !== dto.step || previous.type !== dto.type)
    ) {
      await this.audit(actor, 'STAFF_ASSIST_DRAFT_SAVE', userId, {
        target_user_id: userId,
        type: dto.type,
        step: dto.step,
        progress_pct: dto.progress_pct,
      });
    }
    return result;
  }

  async uploadDocument(
    actor: AuthenticatedUser,
    userId: string,
    file: Express.Multer.File,
    body: {
      document_type: string;
      subject_type: string;
      subject_id?: string;
      draft_key?: string;
    },
  ) {
    await this.getAssistableTarget(userId);
    const doc = (await this.onboardingService.uploadDocument(
      userId,
      file,
      body.document_type,
      body.subject_type,
      body.subject_id || undefined,
      body.draft_key || undefined,
      actor.id,
    )) as { id?: string } | null;
    await this.audit(actor, 'STAFF_ASSIST_DOC_UPLOAD', userId, {
      target_user_id: userId,
      document_id: doc?.id ?? null,
      document_type: body.document_type,
      subject_type: body.subject_type,
    });
    return doc;
  }

  async deleteDocument(
    actor: AuthenticatedUser,
    userId: string,
    documentId: string,
  ) {
    await this.getAssistableTarget(userId);
    // deleteDraftDocument ya exige que el documento sea de este usuario y
    // siga en borrador.
    const result = await this.onboardingService.deleteDraftDocument(
      userId,
      documentId,
    );
    await this.audit(actor, 'STAFF_ASSIST_DOC_DELETE', userId, {
      target_user_id: userId,
      document_id: documentId,
    });
    return result;
  }

  listDocuments(userId: string, subjectType?: string) {
    return this.onboardingService.listDocuments(userId, subjectType);
  }

  /** Ver un documento de identidad es acceso a datos sensibles: se audita. */
  async getDocumentSignedUrl(
    actor: AuthenticatedUser,
    userId: string,
    documentId: string,
  ) {
    const result = await this.onboardingService.getDocumentSignedUrl(
      userId,
      documentId,
    );
    await this.audit(actor, 'STAFF_ASSIST_DOC_VIEW', userId, {
      target_user_id: userId,
      document_id: documentId,
    });
    return result;
  }

  /**
   * Deja el borrador listo para el cliente y le avisa (notificación en la
   * plataforma + correo). Al entrar, el cliente va directo al onboarding.
   */
  async markReady(actor: AuthenticatedUser, userId: string) {
    const target = await this.getAssistableTarget(userId);
    const result = await this.draftService.markReadyForClient(userId, actor.id);

    await this.notifications.sendNotification({
      userId,
      type: NotificationType.ONBOARDING,
      title: 'Tu solicitud está lista para revisar',
      message:
        'Nuestro equipo completó tu solicitud con la información que nos enviaste. Revísala, acepta los términos y envíala para continuar.',
      link: '/onboarding',
    });

    let emailSent = false;
    if (target.email) {
      emailSent = await this.email.sendAssistedOnboardingReadyEmail({
        email: target.email,
        name: target.contact_first_name ?? target.full_name ?? undefined,
      });
    }

    await this.audit(actor, 'STAFF_ASSIST_READY', userId, {
      target_user_id: userId,
      progress_pct: result.progress_pct,
      email_sent: emailSent,
    });

    return { ...result, email_sent: emailSent };
  }

  // ── Internos ──────────────────────────────────────────────────────

  /**
   * Solo se asiste a clientes activos que aún no están aprobados. El
   * personal interno no hace onboarding (ver NotStaffGuard).
   */
  private async getAssistableTarget(userId: string): Promise<AssistTarget> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select(
        'id, email, full_name, company_name, tax_id, contact_first_name, contact_last_name, contact_id_number, phone, onboarding_status, account_type, is_active, is_frozen',
      )
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      this.logger.error(
        `No se pudo leer el perfil ${userId}: ${error.message}`,
      );
      throw new BadRequestException(
        'No se pudo verificar la cuenta del cliente.',
      );
    }
    if (!data) throw new NotFoundException('Cliente no encontrado');

    if (!data.is_active || data.is_frozen) {
      throw new BadRequestException(
        'La cuenta del cliente está inactiva o congelada.',
      );
    }
    if (data.onboarding_status === 'approved') {
      throw new BadRequestException(
        'Este cliente ya tiene su cuenta aprobada.',
      );
    }

    const staffResult = await this.supabase.rpc('staff_get', {
      p_user_id: userId,
    });
    const staff: unknown = staffResult.data;
    if (staffResult.error) {
      throw new BadRequestException(
        'No se pudo verificar la cuenta del cliente.',
      );
    }
    const member: unknown = Array.isArray(staff) ? staff[0] : staff;
    if (member) {
      throw new BadRequestException(
        'Las cuentas del personal interno no hacen onboarding.',
      );
    }

    // Supabase crea el perfil al registrarse, antes de verificar el correo.
    // Sin esta comprobación se podía asistir (y mandar el aviso por correo)
    // a una cuenta abierta con el correo de otra persona.
    const authResult = await this.supabase.auth.admin.getUserById(userId);
    if (authResult.error || !authResult.data?.user) {
      throw new BadRequestException(
        'No se pudo verificar la cuenta del cliente.',
      );
    }
    if (!authResult.data.user.email_confirmed_at) {
      throw new BadRequestException(
        'El cliente todavía no verificó su correo. Pídele que complete la verificación antes de asistirlo.',
      );
    }

    const row = data as AssistTarget & {
      is_active: boolean;
      is_frozen: boolean;
    };
    return {
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      company_name: row.company_name,
      tax_id: row.tax_id,
      contact_first_name: row.contact_first_name,
      contact_last_name: row.contact_last_name,
      contact_id_number: row.contact_id_number,
      phone: row.phone,
      onboarding_status: row.onboarding_status,
      account_type: row.account_type ?? null,
    };
  }

  /** Mismo formato que el resto de acciones de staff; nunca rompe la operación. */
  private async audit(
    actor: AuthenticatedUser,
    action: string,
    userId: string,
    newValues: Record<string, unknown>,
  ) {
    const { error } = await this.supabase.from('audit_logs').insert({
      performed_by: actor.id,
      role: actor.profile.role,
      action,
      table_name: 'onboarding_drafts',
      record_id: userId,
      new_values: newValues,
      source: 'admin_panel',
    });
    if (error) {
      this.logger.error(
        `Error registrando audit log ${action} de ${userId}: ${error.message}`,
      );
    }
  }
}

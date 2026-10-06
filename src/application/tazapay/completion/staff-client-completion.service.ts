import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';
import type { AuthenticatedUser } from '../../../core/guards/supabase-auth.guard';
import { OnboardingService } from '../../onboarding/onboarding.service';
import { CreatePersonDto } from '../../onboarding/dto/create-person.dto';
import { CreateBusinessDto } from '../../onboarding/dto/create-business.dto';
import {
  CreateDirectorDto,
  CreateUboDto,
} from '../../onboarding/dto/create-director-ubo.dto';
import { TazapayKybOnboardingService } from '../onboarding/tazapay-kyb-onboarding.service';
import { TazapayKycOnboardingService } from '../onboarding/tazapay-kyc-onboarding.service';
import {
  StaffUpdateBusinessDto,
  StaffUpdateDirectorDto,
  StaffUpdatePersonDto,
  StaffUpdateUboDto,
} from './staff-client-completion.dto';

type Row = Record<string, unknown>;

/** Personas a las que se les pueden subir documentos. */
const PERSON_SUBJECTS = new Set(['person', 'business', 'director', 'ubo']);

/**
 * Completar los datos de un cliente YA aprobado (p. ej. migrado desde Bridge)
 * para poder enviarlo a Tazapay.
 *
 * A diferencia del onboarding asistido (que llena el borrador y lo firma el
 * cliente), aquí el staff escribe directo en people / businesses / directores
 * / UBOs / documents. Nunca toca el estado de las solicitudes de Bridge ni
 * reenvía nada: el envío a Tazapay es la acción aparte ya existente
 * (providers/kyb|kyc/:id/send-to-tazapay).
 *
 * Auditoría: solo los NOMBRES de los campos cambiados, nunca su contenido
 * (mismo criterio que el onboarding asistido).
 */
@Injectable()
export class StaffClientCompletionService {
  private readonly logger = new Logger(StaffClientCompletionService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly onboarding: OnboardingService,
    private readonly tazapayKyb: TazapayKybOnboardingService,
    private readonly tazapayKyc: TazapayKycOnboardingService,
  ) {}

  // ── Lectura ───────────────────────────────────────────────────────

  async getContext(userId: string) {
    const target = await this.getTarget(userId);
    const [{ data: business }, { data: person }] = await Promise.all([
      this.supabase
        .from('businesses')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle<Row>(),
      this.supabase
        .from('people')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle<Row>(),
    ]);

    const kind: 'company' | 'personal' | null = business
      ? 'company'
      : person
        ? 'personal'
        : target.account_type;

    let directors: Row[] = [];
    let ubos: Row[] = [];
    if (business) {
      const [d, u] = await Promise.all([
        this.supabase
          .from('business_directors')
          .select('*')
          .eq('business_id', business.id)
          .order('created_at', { ascending: true }),
        this.supabase
          .from('business_ubos')
          .select('*')
          .eq('business_id', business.id)
          .order('created_at', { ascending: true }),
      ]);
      directors = (d.data ?? []) as Row[];
      ubos = (u.data ?? []) as Row[];
    }

    const documents = await this.onboarding.listDocuments(userId);

    let kybApplicationId: string | null = null;
    let kycApplicationId: string | null = null;
    let missing: string[] = [];
    if (kind === 'company' && business) {
      kybApplicationId = await this.ensureKybApplication(
        userId,
        business.id as string,
      );
      missing = this.tazapayKyb.missingForTazapay(
        await this.tazapayKyb.loadContext(kybApplicationId),
      );
    } else if (kind === 'personal') {
      if (person) {
        kycApplicationId = await this.ensureKycApplication(
          userId,
          person.id as string,
        );
        missing = this.tazapayKyc.missingForTazapay(
          await this.tazapayKyc.loadContext(kycApplicationId),
        );
      } else {
        missing = ['Datos personales del cliente'];
      }
    } else {
      missing = ['Tipo de cuenta (persona o empresa)'];
    }

    return {
      client: target,
      kind,
      person: person ?? null,
      business: business ?? null,
      directors,
      ubos,
      documents: documents ?? [],
      kyb_application_id: kybApplicationId,
      kyc_application_id: kycApplicationId,
      missing,
    };
  }

  // ── Persona natural ───────────────────────────────────────────────

  async savePerson(
    actor: AuthenticatedUser,
    userId: string,
    dto: StaffUpdatePersonDto,
  ) {
    await this.getTarget(userId);
    const { data: existing } = await this.supabase
      .from('people')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    let saved: Row;
    if (existing) {
      if (dto.date_of_birth && this.age(dto.date_of_birth) < 18) {
        throw new BadRequestException('El titular debe ser mayor de 18 años');
      }
      saved = await this.updateRow('people', 'user_id', userId, dto);
    } else {
      const full = this.assertFull(CreatePersonDto, dto);
      saved = (await this.onboarding.upsertPerson(userId, full)) as Row;
    }
    await this.ensureKycApplication(userId, saved.id as string);
    await this.audit(actor, 'STAFF_COMPLETE_PERSON', 'people', userId, {
      changed_fields: Object.keys(dto),
      created: !existing,
    });
    return saved;
  }

  // ── Empresa ───────────────────────────────────────────────────────

  async saveBusiness(
    actor: AuthenticatedUser,
    userId: string,
    dto: StaffUpdateBusinessDto,
  ) {
    await this.getTarget(userId);
    const { data: existing } = await this.supabase
      .from('businesses')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    let saved: Row;
    if (existing) {
      saved = await this.updateRow('businesses', 'user_id', userId, dto);
    } else {
      const full = this.assertFull(CreateBusinessDto, dto);
      saved = (await this.onboarding.upsertBusiness(userId, full)) as Row;
    }
    await this.ensureKybApplication(userId, saved.id as string);
    await this.audit(actor, 'STAFF_COMPLETE_BUSINESS', 'businesses', userId, {
      changed_fields: Object.keys(dto),
      created: !existing,
    });
    return saved;
  }

  // ── Directores y UBOs ─────────────────────────────────────────────

  async addDirector(
    actor: AuthenticatedUser,
    userId: string,
    dto: CreateDirectorDto,
  ) {
    await this.getTarget(userId);
    // El representante legal se reconcilia (un solo firmante); el resto se agrega.
    const saved = (
      dto.is_signer
        ? await this.onboarding.upsertLegalRepresentative(userId, dto)
        : await this.onboarding.addDirector(userId, dto)
    ) as Row;
    await this.audit(
      actor,
      'STAFF_COMPLETE_DIRECTOR',
      'business_directors',
      saved.id as string,
      {
        target_user_id: userId,
        action: 'create',
      },
    );
    return saved;
  }

  async updateDirector(
    actor: AuthenticatedUser,
    userId: string,
    directorId: string,
    dto: StaffUpdateDirectorDto,
  ) {
    await this.getTarget(userId);
    const businessId = await this.requireBusinessId(userId);
    const saved = await this.updateById(
      'business_directors',
      directorId,
      businessId,
      dto,
    );
    await this.audit(
      actor,
      'STAFF_COMPLETE_DIRECTOR',
      'business_directors',
      directorId,
      {
        target_user_id: userId,
        action: 'update',
        changed_fields: Object.keys(dto),
      },
    );
    return saved;
  }

  async removeDirector(
    actor: AuthenticatedUser,
    userId: string,
    directorId: string,
  ) {
    await this.getTarget(userId);
    const result = await this.onboarding.removeDirector(userId, directorId);
    await this.audit(
      actor,
      'STAFF_COMPLETE_DIRECTOR',
      'business_directors',
      directorId,
      {
        target_user_id: userId,
        action: 'delete',
      },
    );
    return result;
  }

  async addUbo(actor: AuthenticatedUser, userId: string, dto: CreateUboDto) {
    await this.getTarget(userId);
    const saved = (await this.onboarding.upsertUbo(userId, dto)) as Row;
    await this.audit(
      actor,
      'STAFF_COMPLETE_UBO',
      'business_ubos',
      saved.id as string,
      {
        target_user_id: userId,
        action: 'upsert',
      },
    );
    return saved;
  }

  async updateUbo(
    actor: AuthenticatedUser,
    userId: string,
    uboId: string,
    dto: StaffUpdateUboDto,
  ) {
    await this.getTarget(userId);
    const businessId = await this.requireBusinessId(userId);
    // client_uid no es columna de business_ubos.
    const { client_uid: _ignored, ...columns } = dto;
    void _ignored;
    const saved = await this.updateById(
      'business_ubos',
      uboId,
      businessId,
      columns,
    );
    await this.audit(actor, 'STAFF_COMPLETE_UBO', 'business_ubos', uboId, {
      target_user_id: userId,
      action: 'update',
      changed_fields: Object.keys(columns),
    });
    return saved;
  }

  async removeUbo(actor: AuthenticatedUser, userId: string, uboId: string) {
    await this.getTarget(userId);
    const result = await this.onboarding.removeUbo(userId, uboId);
    await this.audit(actor, 'STAFF_COMPLETE_UBO', 'business_ubos', uboId, {
      target_user_id: userId,
      action: 'delete',
    });
    return result;
  }

  // ── Documentos ────────────────────────────────────────────────────

  /**
   * Sube un documento DEFINITIVO (no borrador) a nombre del cliente. Si ya
   * había uno activo del mismo tipo para esa persona, queda reemplazado.
   */
  async uploadDocument(
    actor: AuthenticatedUser,
    userId: string,
    file: Express.Multer.File,
    body: {
      document_type: string;
      subject_type: string;
      subject_id?: string;
      document_subtype?: string;
    },
  ) {
    await this.getTarget(userId);
    if (!PERSON_SUBJECTS.has(body.subject_type)) {
      throw new BadRequestException('subject_type inválido');
    }
    await this.assertSubjectBelongsToClient(
      userId,
      body.subject_type,
      body.subject_id,
    );

    const doc = (await this.onboarding.uploadDocument(
      userId,
      file,
      body.document_type,
      body.subject_type,
      body.subject_id || undefined,
      undefined,
      actor.id,
      body.document_subtype || undefined,
    )) as { id: string } | null;
    if (!doc) throw new BadRequestException('No se pudo guardar el documento');

    // Definitivo: así ningún "reemplazo de borrador" lo borra después.
    const { error } = await this.supabase
      .from('documents')
      .update({ is_draft: false })
      .eq('id', doc.id);
    if (error) {
      this.logger.error(
        `No se pudo marcar definitivo el documento ${doc.id}: ${error.message}`,
      );
    }

    await this.audit(actor, 'STAFF_COMPLETE_DOC_UPLOAD', 'documents', doc.id, {
      target_user_id: userId,
      document_type: body.document_type,
      subject_type: body.subject_type,
    });
    return { ...doc, is_draft: false };
  }

  /** Ver un documento de identidad es acceso a datos sensibles: se audita. */
  async getDocumentSignedUrl(
    actor: AuthenticatedUser,
    userId: string,
    documentId: string,
  ) {
    const result = await this.onboarding.getDocumentSignedUrl(
      userId,
      documentId,
    );
    await this.audit(
      actor,
      'STAFF_COMPLETE_DOC_VIEW',
      'documents',
      documentId,
      {
        target_user_id: userId,
      },
    );
    return result;
  }

  // ── Internos ──────────────────────────────────────────────────────

  /** Solo clientes activos, descongelados, NO staff y ya aprobados. */
  private async getTarget(userId: string) {
    const { data, error } = await this.supabase
      .from('profiles')
      .select(
        'id, email, full_name, company_name, onboarding_status, account_type, is_active, is_frozen',
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
    if (data.onboarding_status !== 'approved') {
      throw new BadRequestException(
        'Solo se completan datos de clientes ya aprobados. Para los demás usa el onboarding asistido.',
      );
    }
    const staff = await this.supabase.rpc('staff_get', { p_user_id: userId });
    if (staff.error) {
      throw new BadRequestException(
        'No se pudo verificar la cuenta del cliente.',
      );
    }
    const member: unknown = Array.isArray(staff.data)
      ? staff.data[0]
      : staff.data;
    if (member) {
      throw new BadRequestException(
        'Las cuentas del personal interno no hacen onboarding.',
      );
    }
    return {
      id: data.id as string,
      email: (data.email as string | null) ?? null,
      full_name: (data.full_name as string | null) ?? null,
      company_name: (data.company_name as string | null) ?? null,
      onboarding_status: data.onboarding_status as string,
      account_type:
        (data.account_type as 'personal' | 'company' | null) ?? null,
    };
  }

  /**
   * Un cliente migrado puede no tener solicitud KYB. Se registra como ya
   * aprobada y de origen 'bridge_migration': no es un envío nuevo a Bridge
   * (nada la procesa) y es lo que necesita la tabla de envíos por proveedor.
   */
  private async ensureKybApplication(userId: string, businessId: string) {
    const { data: existing } = await this.supabase
      .from('kyb_applications')
      .select('id')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) return existing.id as string;

    const { data, error } = await this.supabase
      .from('kyb_applications')
      .insert({
        business_id: businessId,
        requester_user_id: userId,
        status: 'approved',
        provider: 'bridge',
        source: 'bridge_migration',
      })
      .select('id')
      .single();
    if (error || !data) {
      throw new BadRequestException(
        `No se pudo registrar la solicitud KYB del cliente: ${error?.message ?? 'sin datos'}`,
      );
    }
    return data.id as string;
  }

  private async ensureKycApplication(userId: string, personId: string) {
    const { data: existing } = await this.supabase
      .from('kyc_applications')
      .select('id, person_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      if (!existing.person_id) {
        await this.supabase
          .from('kyc_applications')
          .update({ person_id: personId })
          .eq('id', existing.id);
      }
      return existing.id as string;
    }

    const { data, error } = await this.supabase
      .from('kyc_applications')
      .insert({
        user_id: userId,
        person_id: personId,
        status: 'approved',
        provider: 'bridge',
        source: 'bridge_migration',
      })
      .select('id')
      .single();
    if (error || !data) {
      throw new BadRequestException(
        `No se pudo registrar la solicitud KYC del cliente: ${error?.message ?? 'sin datos'}`,
      );
    }
    return data.id as string;
  }

  private async requireBusinessId(userId: string): Promise<string> {
    const { data } = await this.supabase
      .from('businesses')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();
    if (!data)
      throw new BadRequestException('El cliente no tiene empresa registrada.');
    return data.id as string;
  }

  /** El documento solo puede colgar de una persona/empresa de ESTE cliente. */
  private async assertSubjectBelongsToClient(
    userId: string,
    subjectType: string,
    subjectId?: string,
  ) {
    if (!subjectId) {
      throw new BadRequestException('subject_id es obligatorio');
    }
    if (subjectType === 'person') {
      const { data } = await this.supabase
        .from('people')
        .select('id')
        .eq('id', subjectId)
        .eq('user_id', userId)
        .maybeSingle();
      if (!data)
        throw new BadRequestException('La persona no pertenece al cliente.');
      return;
    }
    const businessId = await this.requireBusinessId(userId);
    if (subjectType === 'business') {
      if (subjectId !== businessId) {
        throw new BadRequestException('La empresa no pertenece al cliente.');
      }
      return;
    }
    const table =
      subjectType === 'director' ? 'business_directors' : 'business_ubos';
    const { data } = await this.supabase
      .from(table)
      .select('id')
      .eq('id', subjectId)
      .eq('business_id', businessId)
      .maybeSingle();
    if (!data)
      throw new BadRequestException(
        'La persona no pertenece a la empresa del cliente.',
      );
  }

  private async updateRow(
    table: 'people' | 'businesses',
    column: 'user_id',
    userId: string,
    dto: object,
  ): Promise<Row> {
    const patch = this.definedFields(dto);
    const { data, error } = await this.supabase
      .from(table)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq(column, userId)
      .select()
      .single<Row>();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  private async updateById(
    table: 'business_directors' | 'business_ubos',
    id: string,
    businessId: string,
    dto: object,
  ): Promise<Row> {
    const patch = this.definedFields(dto);
    const { data, error } = await this.supabase
      .from(table)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('business_id', businessId)
      .select()
      .maybeSingle<Row>();
    if (error) throw new BadRequestException(error.message);
    if (!data)
      throw new NotFoundException(
        'Registro no encontrado en la empresa del cliente.',
      );
    return data;
  }

  private definedFields(dto: object): Row {
    return Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    );
  }

  /** Al crear una fila desde cero se exige el DTO completo del formulario. */
  private assertFull<T extends object>(cls: new () => T, body: object): T {
    const instance = plainToInstance(cls, body);
    const errors = validateSync(instance, { whitelist: true });
    if (errors.length > 0) {
      const messages = errors.flatMap((e) =>
        Object.values(e.constraints ?? { [e.property]: 'inválido' }),
      );
      throw new BadRequestException(
        `Faltan datos obligatorios para crear el registro: ${messages.join('; ')}`,
      );
    }
    return instance;
  }

  private age(dateOfBirth: string): number {
    const birth = new Date(dateOfBirth);
    const now = new Date();
    let age = now.getUTCFullYear() - birth.getUTCFullYear();
    const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
    if (
      monthDiff < 0 ||
      (monthDiff === 0 && now.getUTCDate() < birth.getUTCDate())
    ) {
      age -= 1;
    }
    return age;
  }

  private async audit(
    actor: AuthenticatedUser,
    action: string,
    tableName: string,
    recordId: string,
    newValues: Row,
  ) {
    const { error } = await this.supabase.from('audit_logs').insert({
      performed_by: actor.id,
      role: actor.profile.role,
      action,
      table_name: tableName,
      record_id: recordId,
      new_values: newValues,
      source: 'admin_panel',
    });
    if (error) {
      this.logger.error(
        `Error registrando audit log ${action}: ${error.message}`,
      );
    }
  }
}

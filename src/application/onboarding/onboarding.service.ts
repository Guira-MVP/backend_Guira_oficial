import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { CreatePersonDto } from './dto/create-person.dto';
import { CreateBusinessDto } from './dto/create-business.dto';
import { CreateDirectorDto, CreateUboDto } from './dto/create-director-ubo.dto';
import { BridgeApiClient } from '../bridge/bridge-api.client';
import * as crypto from 'crypto';

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const STORAGE_BUCKET = 'kyc-documents';

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly bridgeApiClient: BridgeApiClient,
  ) {}

  // ───────────────────────────────────────────────
  //  KYC — Persona Natural
  // ───────────────────────────────────────────────

  /** Crea o actualiza los datos biográficos de la persona (UPSERT por user_id). */
  async upsertPerson(userId: string, dto: CreatePersonDto) {
    // Validar edad ≥ 18
    const age = this.calculateAge(dto.date_of_birth);
    if (age < 18) {
      throw new BadRequestException('El solicitante debe ser mayor de 18 años');
    }

    // Verificar si ya existe
    const { data: existing } = await this.supabase
      .from('people')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      // Update
      const { data, error } = await this.supabase
        .from('people')
        .update({ ...dto, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .select()
        .single();
      if (error) throw new BadRequestException(error.message);
      return data;
    }

    // Insert
    const { data, error } = await this.supabase
      .from('people')
      .insert({ ...dto, user_id: userId })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Obtiene los datos biográficos del usuario. */
  async getPerson(userId: string) {
    const { data, error } = await this.supabase
      .from('people')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Crea una aplicación KYC vinculada al person del usuario. */
  async createKycApplication(userId: string) {
    // Verificar que exista un person
    const person = await this.getPerson(userId);
    if (!person) {
      throw new BadRequestException(
        'Primero debes completar tus datos personales (POST /onboarding/kyc/person)',
      );
    }

    // Verificar si ya existe una aplicación activa
    const { data: existing } = await this.supabase
      .from('kyc_applications')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['pending', 'submitted', 'in_review', 'needs_review'])
      .maybeSingle();

    if (existing) {
      return existing; // Idempotente: retornar la existente
    }

    const { data, error } = await this.supabase
      .from('kyc_applications')
      .insert({
        user_id: userId,
        person_id: person.id,
        status: 'pending',
        provider: 'bridge',
        source: 'platform',
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    // Actualizar onboarding_status del perfil
    await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'kyc_started' })
      .eq('id', userId);

    return data;
  }

  /** Obtiene el estado de la aplicación KYC del usuario. */
  async getKycApplication(userId: string) {
    const { data, error } = await this.supabase
      .from('kyc_applications')
      .select('*, people(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Registra la aceptación de Terms of Service. */
  async acceptTos(userId: string, tosContractId?: string) {
    const app = await this.getKycApplication(userId);
    if (!app) throw new NotFoundException('No existe aplicación KYC');

    const { data, error } = await this.supabase
      .from('kyc_applications')
      .update({
        tos_accepted_at: new Date().toISOString(),
        tos_contract_id: tosContractId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', app.id)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Genera el link de Terms of Service de Bridge (KYC/KYB) */
  async generateTosLink(userId: string, redirectUri?: string) {
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id')
      .eq('id', userId)
      .single();

    let url = '';

    if (profile?.bridge_customer_id) {
      const res = await this.bridgeApiClient.get<{ url: string }>(
        `/v0/customers/${profile.bridge_customer_id}/tos_acceptance_link`,
      );
      url = res.url;
    } else {
      const idempotencyKey = `tos-link-${userId}-${Date.now()}`;
      const res = await this.bridgeApiClient.post<{ url: string }>(
        `/v0/customers/tos_links`,
        {},
        idempotencyKey,
      );
      url = res.url;
    }

    if (redirectUri) {
      const hasParams = url.includes('?');
      url = `${url}${hasParams ? '&' : '?'}redirect_uri=${encodeURIComponent(
        redirectUri,
      )}`;
    }

    return { url };
  }

  /** Envía el expediente KYC para revisión. */
  async submitKycApplication(userId: string) {
    const app = await this.getKycApplication(userId);
    if (!app) throw new NotFoundException('No existe aplicación KYC');

    if (app.status === 'submitted' || app.status === 'in_review') {
      return app; // Ya fue enviado — idempotente
    }

    // Verificar que haya documentos adjuntos
    const { count } = await this.supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('subject_type', 'person');

    if (!count || count === 0) {
      throw new BadRequestException(
        'Debes adjuntar al menos un documento de identidad antes de enviar',
      );
    }

    // Verificar ToS
    if (!app.tos_accepted_at) {
      throw new BadRequestException(
        'Debes aceptar los Terms of Service antes de enviar',
      );
    }

    const { data, error } = await this.supabase
      .from('kyc_applications')
      .update({
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        observations: null,
        field_observations: {},
      })
      .eq('id', app.id)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    // Actualizar perfil
    await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'in_review' })
      .eq('id', userId);

    // La creación del compliance_review es manejada por el trigger de base de datos 'on_kyc_submitted'.
    // Solo actualizamos la prioridad si es necesario (el trigger la crea como 'normal' por defecto).
    const person = await this.getPerson(userId);
    if (person?.is_pep) {
      await this.supabase
        .from('compliance_reviews')
        .update({ priority: 'high' })
        .eq('subject_type', 'kyc_applications')
        .eq('subject_id', app.id)
        .in('status', ['open', 'in_progress']);
    }

    // Notificar al staff
    await this.notifyStaff(userId, 'Nueva solicitud KYC pendiente de revisión');

    this.logger.log(`KYC application ${app.id} submitted by user ${userId}`);
    return data;
  }

  // ───────────────────────────────────────────────
  //  KYB — Empresa
  // ───────────────────────────────────────────────

  /** Crea o actualiza los datos de la empresa del usuario. */
  async upsertBusiness(userId: string, dto: CreateBusinessDto) {
    const { data: existing } = await this.supabase
      .from('businesses')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing) {
      const { data, error } = await this.supabase
        .from('businesses')
        .update({ ...dto, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .select()
        .single();
      if (error) throw new BadRequestException(error.message);
      return data;
    }

    const { data, error } = await this.supabase
      .from('businesses')
      .insert({ ...dto, user_id: userId })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Obtiene los datos de la empresa del usuario. */
  async getBusiness(userId: string) {
    const { data, error } = await this.supabase
      .from('businesses')
      .select('*, business_directors(*), business_ubos(*)')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Añade un director a la empresa del usuario. */
  async addDirector(userId: string, dto: CreateDirectorDto) {
    const biz = await this.getUserBusiness(userId);

    const { data, error } = await this.supabase
      .from('business_directors')
      .insert({ ...dto, business_id: biz.id })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Elimina un director de la empresa del usuario. */
  async removeDirector(userId: string, directorId: string) {
    const biz = await this.getUserBusiness(userId);

    const { error } = await this.supabase
      .from('business_directors')
      .delete()
      .eq('id', directorId)
      .eq('business_id', biz.id);

    if (error) throw new BadRequestException(error.message);
    return { message: 'Director eliminado' };
  }

  /** Añade un UBO (beneficiario final) a la empresa. */
  async addUbo(userId: string, dto: CreateUboDto) {
    const biz = await this.getUserBusiness(userId);

    const { data, error } = await this.supabase
      .from('business_ubos')
      .insert({ ...dto, business_id: biz.id })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Elimina un UBO. */
  async removeUbo(userId: string, uboId: string) {
    const biz = await this.getUserBusiness(userId);

    const { error } = await this.supabase
      .from('business_ubos')
      .delete()
      .eq('id', uboId)
      .eq('business_id', biz.id);

    if (error) throw new BadRequestException(error.message);
    return { message: 'UBO eliminado' };
  }

  /** Crea aplicación KYB. */
  async createKybApplication(userId: string) {
    const biz = await this.getUserBusiness(userId);

    const { data: existing } = await this.supabase
      .from('kyb_applications')
      .select('*')
      .eq('business_id', biz.id)
      .in('status', ['pending', 'submitted', 'in_review', 'needs_review'])
      .maybeSingle();

    if (existing) return existing;

    const { data, error } = await this.supabase
      .from('kyb_applications')
      .insert({
        business_id: biz.id,
        requester_user_id: userId,
        status: 'pending',
        provider: 'bridge',
        source: 'platform',
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'kyb_started' })
      .eq('id', userId);

    return data;
  }

  /** Obtiene el estado de la aplicación KYB. */
  async getKybApplication(userId: string) {
    const { data: biz } = await this.supabase
      .from('businesses')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (!biz) return null;

    const { data, error } = await this.supabase
      .from('kyb_applications')
      .select('*')
      .eq('business_id', biz.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Envía el expediente KYB para revisión. */
  async submitKybApplication(userId: string) {
    const biz = await this.getUserBusiness(userId);

    const app = await this.getKybApplication(userId);
    if (!app) throw new NotFoundException('No existe aplicación KYB');

    if (app.status === 'submitted' || app.status === 'in_review') {
      return app;
    }

    // Verificar directores
    const { count: dirCount } = await this.supabase
      .from('business_directors')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', biz.id);

    if (!dirCount || dirCount === 0) {
      throw new BadRequestException(
        'Debes agregar al menos un director antes de enviar',
      );
    }

    // Verificar documentos de empresa
    const { count: docCount } = await this.supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('subject_type', 'business');

    if (!docCount || docCount === 0) {
      throw new BadRequestException(
        'Debes adjuntar al menos un documento de la empresa',
      );
    }

    // Verificar ToS
    if (!app.tos_accepted_at) {
      throw new BadRequestException('Debes aceptar los Terms of Service');
    }

    const { data, error } = await this.supabase
      .from('kyb_applications')
      .update({
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        directors_complete: true,
        ubos_complete: true,
        documents_complete: true,
        updated_at: new Date().toISOString(),
        observations: null,
        field_observations: {},
      })
      .eq('id', app.id)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'in_review' })
      .eq('id', userId);

    // La creación del compliance_review es manejada por el trigger de base de datos 'on_kyb_submitted'.

    await this.notifyStaff(userId, 'Nueva solicitud KYB pendiente de revisión');

    this.logger.log(`KYB application ${app.id} submitted by user ${userId}`);
    return data;
  }

  /** Registra ToS para KYB. */
  async acceptKybTos(userId: string, tosContractId?: string) {
    const app = await this.getKybApplication(userId);
    if (!app) throw new NotFoundException('No existe aplicación KYB');

    const { data, error } = await this.supabase
      .from('kyb_applications')
      .update({
        tos_accepted_at: new Date().toISOString(),
        tos_contract_id: tosContractId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', app.id)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  // ───────────────────────────────────────────────
  //  Documentos / Storage
  // ───────────────────────────────────────────────

  /** Sube un documento a Supabase Storage y registra en la tabla documents. */
  async uploadDocument(
    userId: string,
    file: Express.Multer.File,
    documentType: string,
    subjectType: string,
    subjectId?: string,
  ) {
    if (!file) {
      throw new BadRequestException('El archivo no se encontró o está vacío');
    }

    // Validar mime type
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        `Tipo de archivo no permitido: ${file.mimetype}. Permitidos: pdf, jpg, png`,
      );
    }

    // Validar tamaño
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException('El archivo excede el límite de 10 MB');
    }

    // Generar path en storage
    const date = new Date().toISOString().split('T')[0];
    const uniqueId = crypto.randomUUID();
    const ext = file.originalname.split('.').pop();
    const storagePath = `${userId}/${date}_${documentType}_${uniqueId}.${ext}`;

    // Subir a Storage
    const { error: uploadError } = await this.supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (uploadError) {
      this.logger.error(`Error subiendo documento: ${uploadError.message}`);
      throw new BadRequestException(
        `Error subiendo archivo: ${uploadError.message}`,
      );
    }

    // ── Soft-Delete: marcar documentos previos del mismo tipo como 'superseded' ──
    // Esto evita la acumulación de registros duplicados manteniendo historial de auditoría.
    const { data: previousDocs } = await this.supabase
      .from('documents')
      .select('id, storage_path')
      .eq('user_id', userId)
      .eq('document_type', documentType)
      .eq('subject_type', subjectType)
      .eq('status', 'pending');

    if (previousDocs && previousDocs.length > 0) {
      const prevIds = previousDocs.map((d) => d.id);
      await this.supabase
        .from('documents')
        .update({ status: 'superseded' })
        .in('id', prevIds);

      this.logger.log(
        `Marked ${prevIds.length} previous '${documentType}' document(s) as superseded for user ${userId}`,
      );
    }

    // Registrar en tabla documents
    const { data, error } = await this.supabase
      .from('documents')
      .insert({
        user_id: userId,
        subject_type: subjectType,
        subject_id: subjectId ?? null,
        document_type: documentType,
        storage_path: storagePath,
        file_name: file.originalname,
        mime_type: file.mimetype,
        file_size_bytes: file.size,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    return data;
  }

  /** Lista documentos del usuario. */
  async listDocuments(userId: string, subjectType?: string) {
    let query = this.supabase
      .from('documents')
      .select(
        'id, document_type, subject_type, file_name, mime_type, file_size_bytes, status, created_at',
      )
      .eq('user_id', userId)
      .eq('status', 'pending') // Solo documentos activos (excluye superseded)
      .order('created_at', { ascending: false });

    if (subjectType) {
      query = query.eq('subject_type', subjectType);
    }

    const { data, error } = await query;
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  /** Genera URL firmada para descargar un documento (válida 1 hora). */
  async getDocumentSignedUrl(userId: string, documentId: string) {
    const { data: doc, error } = await this.supabase
      .from('documents')
      .select('storage_path, user_id')
      .eq('id', documentId)
      .single();

    if (error || !doc) throw new NotFoundException('Documento no encontrado');

    // Solo el propietario o staff/admin pueden descargar (el guard de roles maneja admin)
    if (doc.user_id !== userId) {
      throw new BadRequestException('No tienes acceso a este documento');
    }

    const { data, error: urlError } = await this.supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(doc.storage_path, 3600);

    if (urlError) throw new BadRequestException(urlError.message);
    return { signed_url: data.signedUrl, expires_in: 3600 };
  }

  // ───────────────────────────────────────────────
  //  Helpers privados
  // ───────────────────────────────────────────────

  private async getUserBusiness(userId: string) {
    const { data, error } = await this.supabase
      .from('businesses')
      .select('id')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException(
        'Primero debes registrar tu empresa (POST /onboarding/kyb/business)',
      );
    }
    return data;
  }

  private calculateAge(dateOfBirth: string): number {
    const dob = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    return age;
  }

  private async notifyStaff(userId: string, message: string) {
    try {
      // Obtener IDs de staff/admin
      const { data: staffUsers } = await this.supabase
        .from('profiles')
        .select('id')
        .in('role', ['staff', 'admin', 'super_admin'])
        .eq('is_active', true);

      if (staffUsers && staffUsers.length > 0) {
        const notifications = staffUsers.map((s) => ({
          user_id: s.id,
          type: 'compliance_review',
          title: 'Nueva solicitud de onboarding',
          message,
          metadata: { requester_user_id: userId },
        }));

        await this.supabase.from('notifications').insert(notifications);
      }
    } catch (err) {
      this.logger.warn(`Error notificando staff: ${err}`);
    }
  }
}

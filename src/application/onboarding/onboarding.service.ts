import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { CreatePersonDto } from './dto/create-person.dto';
import { CreateBusinessDto } from './dto/create-business.dto';
import { CreateDirectorDto, CreateUboDto } from './dto/create-director-ubo.dto';
import { BridgeApiClient } from '../bridge/bridge-api.client';
import { OrdersGateway } from '../orders/orders.gateway';
import { AdminGateway } from '../admin/admin.gateway';
import * as crypto from 'crypto';
import type { MobileDocumentTargetDto } from './dto/create-mobile-token.dto';

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
    private readonly ordersGateway: OrdersGateway,
    private readonly adminGateway: AdminGateway,
    private readonly config: ConfigService,
  ) {}

  /**
   * Valida que redirect_uri pertenezca a uno de los orígenes del frontend
   * configurados en URL_FRONTEND. Previene SSRF/Open Redirect (OWASP A10).
   */
  private validateRedirectUri(redirectUri: string): void {
    const raw = this.config.get<string>('app.urlFrontend') ?? '';
    const allowedOrigins = raw
      .split(',')
      .map((u) => {
        try { return new URL(u.trim()).origin; }
        catch { return null; }
      })
      .filter(Boolean) as string[];

    let parsedOrigin: string;
    try {
      parsedOrigin = new URL(redirectUri).origin;
    } catch {
      throw new BadRequestException('redirect_uri inválido');
    }

    if (!allowedOrigins.includes(parsedOrigin)) {
      throw new BadRequestException(
        'redirect_uri no está en la lista de orígenes permitidos',
      );
    }
  }

  /**
   * Materializa el país de origen del cliente en profiles.country_code para que
   * la resolución de visibilidad de flujos no tenga que joinear people/businesses.
   * Best-effort: un fallo aquí no debe romper el onboarding.
   */
  private async syncProfileCountry(userId: string, countryCode?: string | null) {
    if (!countryCode) return;
    const { error } = await this.supabase
      .from('profiles')
      .update({ country_code: countryCode.toUpperCase() })
      .eq('id', userId);
    if (error) {
      this.logger.warn(
        `No se pudo sincronizar profiles.country_code para ${userId}: ${error.message}`,
      );
    }
  }

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
      if (error) throwDbError(error);
      await this.syncProfileCountry(userId, dto.country_of_residence ?? dto.country);
      return data;
    }

    // Insert
    const { data, error } = await this.supabase
      .from('people')
      .insert({ ...dto, user_id: userId })
      .select()
      .single();
    if (error) throwDbError(error);
    await this.syncProfileCountry(userId, dto.country_of_residence ?? dto.country);
    return data;
  }

  /** Obtiene los datos biográficos del usuario. */
  async getPerson(userId: string) {
    const { data, error } = await this.supabase
      .from('people')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throwDbError(error);
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

    if (error) throwDbError(error);

    // Actualizar onboarding_status del perfil
    const { data: kycStartedProfile } = await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'kyc_started' })
      .eq('id', userId)
      .select('id, role, is_active, is_frozen, frozen_reason, onboarding_status, bridge_customer_id, updated_at')
      .single();

    // WS: notificar al cliente que su estado de onboarding cambió
    this.ordersGateway.emitProfileStatusUpdated(userId, {
      user_id: userId,
      onboarding_status: 'kyc_started',
      updated_at: new Date().toISOString(),
    });

    // WS: notificar al staff que el perfil del usuario cambió
    if (kycStartedProfile) {
      this.adminGateway.emitUserUpdated({
        id: kycStartedProfile.id,
        role: kycStartedProfile.role,
        is_active: kycStartedProfile.is_active,
        is_frozen: kycStartedProfile.is_frozen,
        frozen_reason: kycStartedProfile.frozen_reason ?? null,
        onboarding_status: kycStartedProfile.onboarding_status,
        bridge_customer_id: kycStartedProfile.bridge_customer_id ?? null,
        updated_at: kycStartedProfile.updated_at ?? new Date().toISOString(),
      });
    }

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
    if (error) throwDbError(error);
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

    if (error) throwDbError(error);
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
      this.validateRedirectUri(redirectUri);
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

    if (error) throwDbError(error);

    // Actualizar perfil
    const { data: kycInReviewProfile } = await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'in_review' })
      .eq('id', userId)
      .select('id, role, is_active, is_frozen, frozen_reason, onboarding_status, bridge_customer_id, updated_at')
      .single();

    // WS: notificar al cliente que su solicitud KYC está en revisión
    this.ordersGateway.emitProfileStatusUpdated(userId, {
      user_id: userId,
      onboarding_status: 'in_review',
      updated_at: new Date().toISOString(),
    });

    // WS: notificar al staff que el perfil del usuario cambió
    if (kycInReviewProfile) {
      this.adminGateway.emitUserUpdated({
        id: kycInReviewProfile.id,
        role: kycInReviewProfile.role,
        is_active: kycInReviewProfile.is_active,
        is_frozen: kycInReviewProfile.is_frozen,
        frozen_reason: kycInReviewProfile.frozen_reason ?? null,
        onboarding_status: kycInReviewProfile.onboarding_status,
        bridge_customer_id: kycInReviewProfile.bridge_customer_id ?? null,
        updated_at: kycInReviewProfile.updated_at ?? new Date().toISOString(),
      });
    }

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
      if (error) throwDbError(error);
      await this.syncProfileCountry(userId, dto.country_of_incorporation ?? dto.country);
      return data;
    }

    const { data, error } = await this.supabase
      .from('businesses')
      .insert({ ...dto, user_id: userId })
      .select()
      .single();
    if (error) throwDbError(error);
    await this.syncProfileCountry(userId, dto.country_of_incorporation ?? dto.country);
    return data;
  }

  /** Obtiene los datos de la empresa del usuario. */
  async getBusiness(userId: string) {
    const { data, error } = await this.supabase
      .from('businesses')
      .select('*, business_directors(*), business_ubos(*)')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throwDbError(error);
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

    if (error) throwDbError(error);
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

    if (error) throwDbError(error);
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

    if (error) throwDbError(error);
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

    if (error) throwDbError(error);
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

    if (error) throwDbError(error);

    const { data: kybStartedProfile } = await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'kyb_started' })
      .eq('id', userId)
      .select('id, role, is_active, is_frozen, frozen_reason, onboarding_status, bridge_customer_id, updated_at')
      .single();

    // WS: notificar al cliente que su proceso KYB inició
    this.ordersGateway.emitProfileStatusUpdated(userId, {
      user_id: userId,
      onboarding_status: 'kyb_started',
      updated_at: new Date().toISOString(),
    });

    // WS: notificar al staff que el perfil del usuario cambió
    if (kybStartedProfile) {
      this.adminGateway.emitUserUpdated({
        id: kybStartedProfile.id,
        role: kybStartedProfile.role,
        is_active: kybStartedProfile.is_active,
        is_frozen: kybStartedProfile.is_frozen,
        frozen_reason: kybStartedProfile.frozen_reason ?? null,
        onboarding_status: kybStartedProfile.onboarding_status,
        bridge_customer_id: kybStartedProfile.bridge_customer_id ?? null,
        updated_at: kybStartedProfile.updated_at ?? new Date().toISOString(),
      });
    }

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

    if (error) throwDbError(error);
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

    if (error) throwDbError(error);

    const { data: kybInReviewProfile } = await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'in_review' })
      .eq('id', userId)
      .select('id, role, is_active, is_frozen, frozen_reason, onboarding_status, bridge_customer_id, updated_at')
      .single();

    // WS: notificar al cliente que su solicitud KYB está en revisión
    this.ordersGateway.emitProfileStatusUpdated(userId, {
      user_id: userId,
      onboarding_status: 'in_review',
      updated_at: new Date().toISOString(),
    });

    // WS: notificar al staff que el perfil del usuario cambió
    if (kybInReviewProfile) {
      this.adminGateway.emitUserUpdated({
        id: kybInReviewProfile.id,
        role: kybInReviewProfile.role,
        is_active: kybInReviewProfile.is_active,
        is_frozen: kybInReviewProfile.is_frozen,
        frozen_reason: kybInReviewProfile.frozen_reason ?? null,
        onboarding_status: kybInReviewProfile.onboarding_status,
        bridge_customer_id: kybInReviewProfile.bridge_customer_id ?? null,
        updated_at: kybInReviewProfile.updated_at ?? new Date().toISOString(),
      });
    }

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

    if (error) throwDbError(error);
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

    if (error) throwDbError(error);

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
    if (error) throwDbError(error);
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

  // ─── Mobile Upload Token ───────────────────────────────────────────

  async createMobileToken(
    userId: string,
    type: 'personal' | 'company',
    documents: MobileDocumentTargetDto[],
  ) {
    // Invalidar tokens activos anteriores del mismo usuario
    await this.supabase
      .from('mobile_upload_tokens')
      .update({ completed_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('completed_at', null)
      .gt('expires_at', new Date().toISOString());

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const uniqueKeys = new Set(documents.map((document) => document.key));
    if (uniqueKeys.size !== documents.length) {
      throw new BadRequestException('La selección contiene documentos duplicados');
    }

    const { data: tokenRow, error } = await this.supabase
      .from('mobile_upload_tokens')
      .insert({
        user_id: userId,
        token_hash: tokenHash,
        onboarding_type: type,
        required_docs: documents.map((document) => document.document_type),
        expires_at: expiresAt,
      })
      .select('id')
      .single();
    if (error) throwDbError(error);

    const { error: targetsError } = await this.supabase
      .from('mobile_upload_session_documents')
      .insert(
        documents.map((document) => ({
          token_id: tokenRow.id,
          document_key: document.key,
          document_type: document.document_type,
          subject_type: document.subject_type,
          label: document.label,
          observation: document.observation ?? null,
        })),
      );
    if (targetsError) {
      await this.supabase
        .from('mobile_upload_tokens')
        .delete()
        .eq('id', tokenRow.id);
      throwDbError(targetsError);
    }

    return { token: rawToken, expires_at: expiresAt };
  }

  async resolveMobileToken(rawToken: string) {
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const { data } = await this.supabase
      .from('mobile_upload_tokens')
      .select('id, user_id, onboarding_type, required_docs, expires_at, completed_at')
      .eq('token_hash', hash)
      .maybeSingle();

    if (!data) throw new UnauthorizedException('Token inválido');
    if (data.completed_at) throw new UnauthorizedException('Este enlace ya fue utilizado');
    if (new Date(data.expires_at) < new Date()) throw new UnauthorizedException('Token expirado');

    const { data: documents, error } = await this.supabase
      .from('mobile_upload_session_documents')
      .select(
        'document_key, document_type, subject_type, label, observation, uploaded_at',
      )
      .eq('token_id', data.id)
      .order('created_at', { ascending: true });
    if (error) throwDbError(error);

    return {
      userId: data.user_id as string,
      onboardingType: data.onboarding_type as string,
      requiredDocs: data.required_docs as string[],
      tokenId: data.id as string,
      documents: (documents ?? []).map((document) => ({
        key: document.document_key as string,
        document_type: document.document_type as string,
        subject_type: document.subject_type as string,
        label: document.label as string,
        observation: (document.observation as string | null) ?? null,
        uploaded: !!document.uploaded_at,
      })),
    };
  }

  async uploadMobileDocument(
    session: Awaited<ReturnType<OnboardingService['resolveMobileToken']>>,
    file: Express.Multer.File,
    documentKey: string,
    documentType: string,
    subjectType: string,
  ) {
    const target = session.documents.find(
      (document) => document.key === documentKey,
    );
    if (
      !target ||
      target.document_type !== documentType ||
      target.subject_type !== subjectType
    ) {
      throw new BadRequestException(
        'El documento no pertenece a esta sesión móvil',
      );
    }

    const uploaded = await this.uploadDocument(
      session.userId,
      file,
      target.document_type,
      target.subject_type,
    );

    const { error } = await this.supabase
      .from('mobile_upload_session_documents')
      .update({
        uploaded_document_id: uploaded.id,
        uploaded_at: new Date().toISOString(),
      })
      .eq('token_id', session.tokenId)
      .eq('document_key', target.key);
    if (error) throwDbError(error);

    return uploaded;
  }

  async getMobileTokenStatus(userId: string, rawToken: string) {
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const { data } = await this.supabase
      .from('mobile_upload_tokens')
      .select('id, expires_at, completed_at, required_docs')
      .eq('token_hash', hash)
      .eq('user_id', userId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Token no encontrado');

    const { data: docs, error } = await this.supabase
      .from('mobile_upload_session_documents')
      .select('document_key, uploaded_at')
      .eq('token_id', data.id);
    if (error) throwDbError(error);

    return {
      completed: !!data.completed_at,
      uploaded_docs: (docs ?? [])
        .filter((document) => !!document.uploaded_at)
        .map((document) => document.document_key as string),
      expires_at: data.expires_at,
    };
  }

  async completeMobileToken(
    session: Awaited<ReturnType<OnboardingService['resolveMobileToken']>>,
  ) {
    if (session.documents.length === 0) {
      throw new BadRequestException('La sesión no contiene documentos');
    }
    const missing = session.documents.filter((document) => !document.uploaded);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Faltan documentos por cargar: ${missing.map((document) => document.label).join(', ')}`,
      );
    }

    const { error } = await this.supabase
      .from('mobile_upload_tokens')
      .update({ completed_at: new Date().toISOString() })
      .eq('id', session.tokenId);
    if (error) throwDbError(error);
  }
}

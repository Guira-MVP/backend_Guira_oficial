import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import {
  RegisterDocumentDto,
  GetDocumentUploadUrlDto,
} from './dto/document.dto';

/**
 * ComplianceService — Lectura de estado de compliance para el usuario.
 *
 * NOTA: La lógica de creación/submit de KYC/KYB vive exclusivamente en
 * OnboardingService para evitar duplicación. Este servicio se limita a:
 * - Documentos (upload URLs, registro, listado)
 * - Lectura de reviews para el usuario
 * - Consulta de estado de aplicaciones
 */
@Injectable()
export class ComplianceService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  // ── Documentos ────────────────────────────────────────────────────

  /** URL firmada para que el frontend suba directamente a Storage */
  async getDocumentUploadUrl(userId: string, dto: GetDocumentUploadUrlDto) {
    const path = `${userId}/${Date.now()}-${dto.file_name}`;
    const { data, error } = await this.supabase.storage
      .from(dto.bucket)
      .createSignedUploadUrl(path);

    if (error) throw new Error(error.message);
    return {
      upload_url: data.signedUrl,
      storage_path: `${dto.bucket}/${path}`,
    };
  }

  /** Registra un documento en la BD tras haberlo subido a Storage */
  async registerDocument(userId: string, dto: RegisterDocumentDto) {
    const { data, error } = await this.supabase
      .from('documents')
      .insert({ user_id: userId, ...dto })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  /** Lista documentos del usuario */
  async listDocuments(userId: string, subjectType?: string) {
    let query = this.supabase
      .from('documents')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (subjectType) query = query.eq('subject_type', subjectType);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  // ── KYC Application (Lectura) ─────────────────────────────────────

  /** Obtiene la KYC application activa del usuario */
  async getKycApplication(userId: string) {
    const { data, error } = await this.supabase
      .from('kyc_applications')
      .select(`*, people (*)`)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data;
  }

  // ── KYB Application (Lectura) ─────────────────────────────────────

  /** Obtiene la KYB application con datos de negocio */
  async getKybApplication(userId: string) {
    // Primero buscar el business del usuario
    const { data: biz } = await this.supabase
      .from('businesses')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (!biz) return null;

    const { data, error } = await this.supabase
      .from('kyb_applications')
      .select(`*, businesses (*, business_directors(*), business_ubos(*))`)
      .eq('business_id', biz.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data;
  }

  // ── Compliance Reviews (lectura) ──────────────────────────────────

  async getComplianceReviews(userId: string) {
    // C11 FIX: subject_id contiene IDs de aplicaciones (kyc/kyb), no user_id.
    // Primero resolvemos los IDs de aplicaciones del usuario.
    const { data: kycApps } = await this.supabase
      .from('kyc_applications')
      .select('id')
      .eq('user_id', userId);

    const { data: kybApps } = await this.supabase
      .from('kyb_applications')
      .select('id')
      .eq('requester_user_id', userId);

    const subjectIds = [
      ...(kycApps ?? []).map((a) => a.id),
      ...(kybApps ?? []).map((a) => a.id),
    ];

    if (subjectIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from('compliance_reviews')
      .select('*')
      .in('subject_id', subjectIds)
      .order('opened_at', { ascending: false });

    if (error) throw new Error(error.message);
    return data ?? [];
  }
}

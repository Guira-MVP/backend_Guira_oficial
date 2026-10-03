import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';
import { TazapayApiClient } from '../tazapay-api.client';
import {
  buildBusinessEntityDraft,
  TazapayBusinessEntityDraft,
  TazapayMappingError,
} from './tazapay-business-mapper';
import {
  BUSINESS_DOCUMENT_SLOTS,
  missingBusinessDocuments,
  personDocumentSpec,
  SHAREHOLDING_FROM_INCORPORATION,
  TazapayDocumentSpec,
} from './tazapay-document-map';
import {
  evaluateIndustry,
  IndustryEvaluation,
  NaicsRule,
  normalizeIndustryCodes,
} from './tazapay-eligibility';
import {
  redactedSnapshot,
  StoredDocument,
  TazapayDocumentRef,
  TazapayDocumentUploader,
} from './tazapay-document-uploader';

export type KybEligibility =
  | { status: 'eligible'; vertical: string; evaluation: IndustryEvaluation }
  | {
      status: 'pending_provider_confirmation' | 'not_eligible' | 'pending';
      reason: string;
      evaluation?: IndustryEvaluation;
    };

interface SubmissionRow {
  id: string;
  user_id: string;
  kyb_application_id: string;
  external_id: string | null;
  idempotency_key: string;
  attempt_count: number;
}

/**
 * Envío de un expediente KYB a Tazapay como entity de empresa:
 *   1. POST /v3/entity (borrador, submit:false) — solo la primera vez
 *   2. subida de documentos (URL presignada + PUT), sin repetir los ya subidos
 *   3. PUT /v3/entity/{id} con documentos, representantes y casillas
 *   4. POST /v3/entity/{id}/submit
 * El estado posterior llega por webhook (entity.approval_*).
 */
@Injectable()
export class TazapayKybOnboardingService {
  private readonly logger = new Logger(TazapayKybOnboardingService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly api: TazapayApiClient,
    private readonly uploader: TazapayDocumentUploader,
  ) {}

  get isConfigured(): boolean {
    return this.api.isConfigured;
  }

  // ── Vertical y elegibilidad ────────────────────────────────────────────

  async loadRules(): Promise<NaicsRule[]> {
    const { data, error } = await this.supabase
      .from('naics_tazapay_vertical_map')
      .select('naics_prefix, vertical, quality, requires_compliance, note');
    if (error)
      throw new Error(
        `No se pudo leer naics_tazapay_vertical_map: ${error.message}`,
      );
    return (data ?? []) as NaicsRule[];
  }

  async evaluateBusiness(
    business: Record<string, unknown>,
  ): Promise<IndustryEvaluation> {
    return evaluateIndustry({
      industryCodes: normalizeIndustryCodes(business.business_industry),
      rules: await this.loadRules(),
      highRiskActivities:
        (business.high_risk_activities as string[] | null) ?? [],
      conductsMoneyServices: business.conducts_money_services as boolean | null,
    });
  }

  /**
   * Guarda el vertical propuesto si el staff todavía no confirmó uno.
   * Devuelve la evaluación para mostrarla en el panel.
   */
  async proposeVertical(
    businessId: string,
  ): Promise<IndustryEvaluation | null> {
    const { data: business } = await this.supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .maybeSingle();
    if (!business) return null;
    const evaluation = await this.evaluateBusiness(business);
    if (!business.tazapay_vertical_confirmed_at) {
      await this.supabase
        .from('businesses')
        .update({
          tazapay_vertical: evaluation.vertical,
          tazapay_vertical_quality: evaluation.quality,
        })
        .eq('id', businessId);
    }
    return evaluation;
  }

  async listVerticals(): Promise<
    Array<{ vertical: string; vgroup: string; high_risk: boolean }>
  > {
    const { data } = await this.supabase
      .from('tazapay_industry_verticals')
      .select('vertical, vgroup, high_risk')
      .eq('is_active', true)
      .order('vertical');
    return (data ?? []) as Array<{
      vertical: string;
      vgroup: string;
      high_risk: boolean;
    }>;
  }

  /**
   * El staff confirma (o cambia) el vertical. Solo se permite cuando la
   * industria tiene un vertical honesto (calidad exacta o genérica): para
   * "confirmar con Tazapay", "sin vertical" y "no elegible" no hay botón
   * para forzar el envío.
   */
  async confirmVertical(
    businessId: string,
    vertical: string,
    actorId: string,
  ): Promise<IndustryEvaluation> {
    const { data: business } = await this.supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .maybeSingle();
    if (!business) throw new TazapayMappingError('Empresa no encontrada.');
    const evaluation = await this.evaluateBusiness(business);
    if (evaluation.quality !== 'exacta' && evaluation.quality !== 'generica') {
      throw new TazapayMappingError(
        `La industria de esta empresa no tiene un vertical válido en Tazapay (${evaluation.quality}): no se puede confirmar. ${evaluation.reasons.join(' ')}`,
      );
    }
    const { data: exists } = await this.supabase
      .from('tazapay_industry_verticals')
      .select('vertical')
      .eq('vertical', vertical)
      .eq('is_active', true)
      .maybeSingle();
    if (!exists)
      throw new TazapayMappingError(
        'El vertical elegido no está en el catálogo de Tazapay.',
      );

    await this.supabase
      .from('businesses')
      .update({
        tazapay_vertical: vertical,
        tazapay_vertical_quality: evaluation.quality,
        tazapay_vertical_confirmed_by: actorId,
        tazapay_vertical_confirmed_at: new Date().toISOString(),
      })
      .eq('id', businessId);
    return evaluation;
  }

  async setShareholdingSameAsRegistration(
    businessId: string,
    value: boolean,
  ): Promise<void> {
    await this.supabase
      .from('businesses')
      .update({ shareholding_same_as_registration: value })
      .eq('id', businessId);
  }

  async checkEligibility(
    business: Record<string, unknown>,
  ): Promise<KybEligibility> {
    if (business.is_dao === true) {
      return {
        status: 'not_eligible',
        reason: 'DAO: Tazapay no tiene un tipo de entidad equivalente.',
      };
    }
    const evaluation = await this.evaluateBusiness(business);
    const why = evaluation.reasons.join(' ');
    if (
      evaluation.quality === 'no_elegible' ||
      evaluation.quality === 'sin_vertical'
    ) {
      return {
        status: 'not_eligible',
        reason: why || 'Industria sin vertical en Tazapay.',
        evaluation,
      };
    }
    if (evaluation.quality === 'confirmar_tazapay') {
      return {
        status: 'pending_provider_confirmation',
        reason:
          why || 'Actividad pendiente de confirmación escrita de Tazapay.',
        evaluation,
      };
    }
    if (!business.tazapay_vertical_confirmed_at || !business.tazapay_vertical) {
      return {
        status: 'pending',
        reason: 'Falta que el staff confirme el vertical de Tazapay.',
        evaluation,
      };
    }
    return {
      status: 'eligible',
      vertical: String(business.tazapay_vertical),
      evaluation,
    };
  }

  // ── Contexto del expediente ────────────────────────────────────────────

  async loadContext(kybApplicationId: string) {
    const { data: kyb } = await this.supabase
      .from('kyb_applications')
      .select('id, business_id, requester_user_id')
      .eq('id', kybApplicationId)
      .single();
    if (!kyb?.business_id)
      throw new TazapayMappingError('Expediente KYB sin empresa asociada.');

    const [
      { data: business },
      { data: directors },
      { data: ubos },
      { data: docs },
    ] = await Promise.all([
      this.supabase
        .from('businesses')
        .select('*')
        .eq('id', kyb.business_id)
        .single(),
      this.supabase
        .from('business_directors')
        .select('*')
        .eq('business_id', kyb.business_id),
      this.supabase
        .from('business_ubos')
        .select('*')
        .eq('business_id', kyb.business_id),
      this.supabase
        .from('documents')
        .select(
          'id, document_type, document_subtype, storage_path, mime_type, file_name, subject_type, subject_id, created_at',
        )
        .eq('user_id', kyb.requester_user_id)
        .neq('status', 'superseded')
        .order('created_at', { ascending: false }),
    ]);
    if (!business)
      throw new TazapayMappingError(
        'No se encontró la empresa del expediente.',
      );

    return {
      userId: String(kyb.requester_user_id),
      business: business as Record<string, unknown>,
      directors: (directors ?? []) as Record<string, unknown>[],
      ubos: (ubos ?? []) as Record<string, unknown>[],
      documents: (docs ?? []) as StoredDocument[],
    };
  }

  /** Faltantes para enviar a Tazapay (documentos de la empresa y de cada persona). */
  missingForTazapay(
    ctx: Awaited<ReturnType<TazapayKybOnboardingService['loadContext']>>,
  ): string[] {
    const businessDocs = new Set(
      ctx.documents
        .filter((d) => d.subject_type === 'business')
        .map((d) => d.document_type),
    );
    const missing = missingBusinessDocuments({
      entityType: String(ctx.business.entity_type ?? ''),
      available: businessDocs,
      ownershipInIncorporationDoc:
        ctx.business.ownership_in_incorporation_doc === true,
      shareholdingSameAsRegistration:
        ctx.business.shareholding_same_as_registration === true,
    });
    const people: Array<{ subject: string; id: string; name: string }> = [
      ...ctx.directors.map((d) => ({
        subject: 'director',
        id: String(d.id),
        name: `${String(d.first_name)} ${String(d.last_name ?? '')}`,
      })),
      ...ctx.ubos
        .filter((u) => !u.director_id)
        .map((u) => ({
          subject: 'ubo',
          id: String(u.id),
          name: `${String(u.first_name)} ${String(u.last_name ?? '')}`,
        })),
    ];
    for (const person of people) {
      const own = ctx.documents.filter(
        (d) => d.subject_type === person.subject && d.subject_id === person.id,
      );
      if (
        !own.some(
          (d) =>
            personDocumentSpec(d.document_type)?.type === 'proof_of_identity',
        )
      ) {
        missing.push(`Documento de identidad de ${person.name.trim()}`);
      }
      if (!own.some((d) => d.document_type === 'proof_of_address')) {
        missing.push(`Comprobante de domicilio de ${person.name.trim()}`);
      }
    }
    return missing;
  }

  // ── Envío ──────────────────────────────────────────────────────────────

  /**
   * Ejecuta (o reanuda) el envío. Idempotente: si la entity ya existe la
   * reutiliza, y los documentos ya subidos no se vuelven a subir.
   * Devuelve el id de la entity y el estado crudo de Tazapay.
   */
  async run(submission: SubmissionRow): Promise<{
    entityId: string;
    rawStatus: string | null;
    requestSnapshot: Record<string, unknown>;
  }> {
    const ctx = await this.loadContext(submission.kyb_application_id);

    const missing = this.missingForTazapay(ctx);
    if (missing.length > 0) {
      throw new TazapayMappingError(
        `Faltan datos para Tazapay: ${missing.join('; ')}.`,
      );
    }

    const draft = buildBusinessEntityDraft({
      userId: ctx.userId,
      business: ctx.business,
      directors: ctx.directors,
      ubos: ctx.ubos,
      vertical: String(ctx.business.tazapay_vertical),
    });

    // 1. Entity en borrador (solo la primera vez).
    let entityId = submission.external_id;
    if (!entityId) {
      const created = await this.api.post<{ data?: { id?: string } }>(
        '/v3/entity',
        { ...this.entityBody(draft), submit: false },
        `${submission.idempotency_key}:create`,
      );
      entityId = created?.data?.id ?? null;
      if (!entityId)
        throw new Error('Tazapay no devolvió el id de la entity creada.');
      await this.supabase
        .from('provider_onboarding_submissions')
        .update({
          external_id: entityId,
          status: 'draft',
          updated_at: new Date().toISOString(),
        })
        .eq('id', submission.id);
    }

    // 2. Documentos.
    await this.supabase
      .from('provider_onboarding_submissions')
      .update({
        status: 'uploading_documents',
        updated_at: new Date().toISOString(),
      })
      .eq('id', submission.id);
    const { entityDocuments, representativeDocuments } =
      await this.uploadDocuments(submission.id, ctx, draft);

    // 3. Datos completos + casillas (solo PUT las acepta).
    const fullBody = {
      ...this.entityBody(draft),
      documents: entityDocuments,
      representatives: draft.representatives.map((rep, i) => ({
        ...this.representativeBody(rep),
        documents: representativeDocuments[i] ?? [],
      })),
      ...draft.flags,
    };
    await this.api.put(`/v3/entity/${entityId}`, fullBody);

    // 4. Someter.
    const submitted = await this.api.post<{
      data?: { approval_status?: string };
    }>(
      `/v3/entity/${entityId}/submit`,
      fullBody,
      `${submission.idempotency_key}:submit`,
    );

    return {
      entityId,
      rawStatus: submitted?.data?.approval_status ?? null,
      requestSnapshot: redactedSnapshot(fullBody),
    };
  }

  async fetchEntityStatus(entityId: string): Promise<string | null> {
    const res = await this.api.get<{ data?: { approval_status?: string } }>(
      `/v3/entity/${entityId}`,
    );
    return res?.data?.approval_status ?? null;
  }

  private entityBody(
    draft: TazapayBusinessEntityDraft,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      name: draft.name,
      type: draft.type,
      registration_number: draft.registration_number,
      registration_address: draft.registration_address,
      operating_address: draft.operating_address,
      relationship: draft.relationship,
      purpose_of_use: draft.purpose_of_use,
      reference_id: draft.reference_id,
      vertical: draft.vertical,
      representatives: draft.representatives.map((r) =>
        this.representativeBody(r),
      ),
    };
    for (const key of [
      'email',
      'description',
      'registration_date',
      'tax_id',
      'tax_id_type',
      'website',
      'phone',
    ] as const) {
      if (draft[key] !== undefined) body[key] = draft[key];
    }
    return body;
  }

  private representativeBody(
    rep: TazapayBusinessEntityDraft['representatives'][number],
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      first_name: rep.first_name,
      date_of_birth: rep.date_of_birth,
      nationality: rep.nationality,
      ownership_percentage: rep.ownership_percentage,
      roles: rep.roles,
    };
    if (rep.last_name) body.last_name = rep.last_name;
    if (rep.address) body.address = rep.address;
    if (rep.phone) body.phone = rep.phone;
    return body;
  }

  private async uploadDocuments(
    submissionId: string,
    ctx: Awaited<ReturnType<TazapayKybOnboardingService['loadContext']>>,
    draft: TazapayBusinessEntityDraft,
  ): Promise<{
    entityDocuments: TazapayDocumentRef[];
    representativeDocuments: TazapayDocumentRef[][];
  }> {
    const latest = (predicate: (d: StoredDocument) => boolean) =>
      ctx.documents.find(predicate);

    // Empresa: el documento más reciente de cada tipo.
    const entityDocuments: TazapayDocumentRef[] = [];
    for (const [documentType, spec] of Object.entries(
      BUSINESS_DOCUMENT_SLOTS,
    )) {
      const doc = latest(
        (d) =>
          d.subject_type === 'business' && d.document_type === documentType,
      );
      if (doc)
        entityDocuments.push(
          await this.uploader.uploadOne(submissionId, doc, spec),
        );
    }
    // Estructura accionaria tomada del testimonio, si el cliente lo indicó.
    const hasOwnShareholding = entityDocuments.some(
      (d) => d.type === 'shareholder_registry',
    );
    if (
      !hasOwnShareholding &&
      ctx.business.ownership_in_incorporation_doc === true
    ) {
      const testimonio = latest(
        (d) =>
          d.subject_type === 'business' &&
          d.document_type === 'incorporation_certificate',
      );
      if (testimonio)
        entityDocuments.push(
          await this.uploader.uploadOne(
            submissionId,
            testimonio,
            SHAREHOLDING_FROM_INCORPORATION,
          ),
        );
    }

    // Personas: identidad + comprobante de domicilio. Si el representante
    // también es socio, se toman los documentos de los dos registros.
    const representativeDocuments: TazapayDocumentRef[][] = [];
    for (const rep of draft.representatives) {
      const owners = [
        { subject: rep.source.type, id: rep.source.id },
        ...(rep.source.linkedUboId
          ? [{ subject: 'ubo', id: rep.source.linkedUboId }]
          : []),
      ];
      const refs: TazapayDocumentRef[] = [];
      const usedSlots = new Set<string>();
      for (const owner of owners) {
        const own = ctx.documents.filter(
          (d) => d.subject_type === owner.subject && d.subject_id === owner.id,
        );
        for (const doc of own) {
          const spec = personDocumentSpec(
            doc.document_type,
            doc.document_subtype,
          );
          if (!spec || usedSlots.has(spec.slot)) continue;
          usedSlots.add(spec.slot);
          refs.push(await this.uploader.uploadOne(submissionId, doc, spec));
        }
      }
      representativeDocuments.push(refs);
    }
    return { entityDocuments, representativeDocuments };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';
import { TazapayApiClient } from '../tazapay-api.client';
import { TazapayMappingError } from './tazapay-business-mapper';
import { personDocumentSpec } from './tazapay-document-map';
import {
  redactedSnapshot,
  StoredDocument,
  TazapayDocumentRef,
  TazapayDocumentUploader,
} from './tazapay-document-uploader';
import {
  buildIndividualEntityDraft,
  missingIndividualData,
  TazapayIndividualEntityDraft,
} from './tazapay-individual-mapper';

/**
 * Solo cuentan los documentos de identidad del tipo declarado: si el cliente
 * cambió de carnet a pasaporte, el archivo viejo no debe ir a Tazapay.
 */
function matchesIdType(documentType: string, idType: unknown): boolean {
  const spec = personDocumentSpec(documentType);
  if (spec?.type !== 'proof_of_identity') return true;
  return (
    documentType === idType || documentType.startsWith(`${String(idType)}_`)
  );
}

interface KycSubmissionRow {
  id: string;
  user_id: string;
  kyc_application_id: string;
  external_id: string | null;
  idempotency_key: string;
}

/**
 * Envío de un expediente KYC a Tazapay como entity `individual`. Mismos pasos
 * que el KYB (borrador → documentos → PUT completo → submit), sin vertical:
 * en personas la elegibilidad es tener los datos y documentos completos.
 */
@Injectable()
export class TazapayKycOnboardingService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly api: TazapayApiClient,
    private readonly uploader: TazapayDocumentUploader,
  ) {}

  get isConfigured(): boolean {
    return this.api.isConfigured;
  }

  async loadContext(kycApplicationId: string) {
    const { data: kyc } = await this.supabase
      .from('kyc_applications')
      .select('id, user_id, person_id')
      .eq('id', kycApplicationId)
      .single();
    if (!kyc?.person_id)
      throw new TazapayMappingError('Expediente KYC sin persona asociada.');

    const [{ data: person }, { data: docs }] = await Promise.all([
      this.supabase.from('people').select('*').eq('id', kyc.person_id).single(),
      this.supabase
        .from('documents')
        .select(
          'id, document_type, document_subtype, storage_path, mime_type, file_name, subject_type, subject_id, created_at',
        )
        .eq('user_id', kyc.user_id)
        .eq('subject_type', 'person')
        .neq('status', 'superseded')
        .order('created_at', { ascending: false }),
    ]);
    if (!person)
      throw new TazapayMappingError(
        'No se encontró la persona del expediente.',
      );

    return {
      userId: String(kyc.user_id),
      person: person as Record<string, unknown>,
      documents: (docs ?? []) as StoredDocument[],
    };
  }

  /** Datos y documentos que faltan para enviar la persona a Tazapay. */
  missingForTazapay(
    ctx: Awaited<ReturnType<TazapayKycOnboardingService['loadContext']>>,
  ): string[] {
    const missing = missingIndividualData(ctx.person);
    const specs = ctx.documents
      .filter((d) => matchesIdType(d.document_type, ctx.person.id_type))
      .map((d) => personDocumentSpec(d.document_type, d.document_subtype));
    if (!specs.some((s) => s?.slot === 'identity_front'))
      missing.push('Documento de identidad (frente o página principal)');
    if (!specs.some((s) => s?.slot === 'address'))
      missing.push('Comprobante de domicilio');
    return missing;
  }

  /**
   * Ejecuta (o reanuda) el envío. Idempotente como el KYB: reutiliza la
   * entity si ya existe y no vuelve a subir documentos ya subidos.
   */
  async run(submission: KycSubmissionRow): Promise<{
    entityId: string;
    rawStatus: string | null;
    requestSnapshot: Record<string, unknown>;
  }> {
    const ctx = await this.loadContext(submission.kyc_application_id);
    const missing = this.missingForTazapay(ctx);
    if (missing.length > 0) {
      throw new TazapayMappingError(
        `Faltan datos para Tazapay: ${missing.join('; ')}.`,
      );
    }

    const draft = buildIndividualEntityDraft({
      userId: ctx.userId,
      person: ctx.person,
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

    // 2. Documentos: identidad (frente y dorso) y comprobante de domicilio.
    await this.supabase
      .from('provider_onboarding_submissions')
      .update({
        status: 'uploading_documents',
        updated_at: new Date().toISOString(),
      })
      .eq('id', submission.id);
    const documents = await this.uploadDocuments(
      submission.id,
      ctx.documents.filter((d) =>
        matchesIdType(d.document_type, ctx.person.id_type),
      ),
    );

    // 3. Datos completos con documentos, 4. someter.
    const fullBody = { ...this.entityBody(draft), documents };
    await this.api.put(`/v3/entity/${entityId}`, fullBody);
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

  private entityBody(
    draft: TazapayIndividualEntityDraft,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      name: draft.name,
      type: draft.type,
      registration_address: draft.registration_address,
      relationship: draft.relationship,
      purpose_of_use: draft.purpose_of_use,
      reference_id: draft.reference_id,
      individual: draft.individual,
    };
    for (const key of ['email', 'phone', 'tax_id', 'tax_id_type'] as const) {
      if (draft[key] !== undefined) body[key] = draft[key];
    }
    return body;
  }

  /** El documento más reciente de cada casilla (la lista viene ordenada). */
  private async uploadDocuments(
    submissionId: string,
    documents: StoredDocument[],
  ): Promise<TazapayDocumentRef[]> {
    const refs: TazapayDocumentRef[] = [];
    const usedSlots = new Set<string>();
    for (const doc of documents) {
      const spec = personDocumentSpec(doc.document_type, doc.document_subtype);
      if (!spec || usedSlots.has(spec.slot)) continue;
      usedSlots.add(spec.slot);
      refs.push(await this.uploader.uploadOne(submissionId, doc, spec));
    }
    return refs;
  }
}

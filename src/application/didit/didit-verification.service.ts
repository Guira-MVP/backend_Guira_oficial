import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { DiditApiClient } from './didit-api.client';
import {
  ALPHA3_TO_ALPHA2,
  DIDIT_DOC_TYPE_BACK_MAP,
  DIDIT_DOC_TYPE_FRONT_PRIORITY,
  DIDIT_FACE_MATCH_ACCEPTED_MIME,
  DIDIT_FACE_MATCH_DECLINE_THRESHOLD,
  DIDIT_FACE_MATCH_MAX_BYTES,
  DIDIT_FACE_MATCH_REF_PRIORITY,
  DIDIT_ID_VERIFICATION_MAX_BYTES,
  DIDIT_SELFIE_DOC_TYPE,
} from './didit.constants';
import {
  DiditAmlRaw,
  DiditFaceMatchRaw,
  DiditFile,
  DiditIdVerificationRaw,
  DiditVerdict,
} from './didit.types';

const STORAGE_BUCKET = 'kyc-documents';

interface StoredDocument {
  document_type: string;
  storage_path: string;
  mime_type: string;
  file_size_bytes: number | null;
}

@Injectable()
export class DiditVerificationService {
  private readonly logger = new Logger(DiditVerificationService.name);

  /** Evita disparar dos verificaciones concurrentes sobre el mismo expediente (doble clic, dos revisores). */
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly diditApiClient: DiditApiClient,
  ) {}

  async runForReview(
    reviewId: string,
    actorId: string,
    actorRole: string,
    force = false,
  ): Promise<{ verdict: DiditVerdict; reused: boolean }> {
    const { data: review } = await this.supabase
      .from('compliance_reviews')
      .select('subject_type, subject_id')
      .eq('id', reviewId)
      .single();

    if (!review) throw new NotFoundException('Review no encontrado');
    if (review.subject_type !== 'kyc_applications') {
      throw new BadRequestException(
        'La pre-verificación con Didit solo está disponible para expedientes KYC (personas).',
      );
    }

    const kycApplicationId = review.subject_id as string;

    if (this.inFlight.has(kycApplicationId)) {
      throw new ConflictException(
        'Ya hay una verificación de Didit en curso para este expediente.',
      );
    }
    this.inFlight.add(kycApplicationId);

    try {
      const { data: kyc } = await this.supabase
        .from('kyc_applications')
        .select('id, user_id, person_id, screening')
        .eq('id', kycApplicationId)
        .single();

      if (!kyc) throw new NotFoundException('Expediente KYC no encontrado');

      const existingDidit = kyc.screening?.didit as DiditVerdict | undefined;
      if (existingDidit && !force) {
        return { verdict: existingDidit, reused: true };
      }

      if (!kyc.person_id) {
        throw new BadRequestException(
          'El expediente no tiene una persona asociada (person_id vacío).',
        );
      }

      const { data: person } = await this.supabase
        .from('people')
        .select(
          'first_name, middle_name, last_name, date_of_birth, nationality, id_number',
        )
        .eq('id', kyc.person_id)
        .single();

      if (!person) throw new NotFoundException('Datos de la persona no encontrados');

      const documents = await this.loadPersonDocuments(kyc.user_id);
      const vendorData = `guira:${kycApplicationId}`;

      const [idResult, faceResult, amlResult] = await Promise.allSettled([
        this.runIdVerification(documents, vendorData),
        this.runFaceMatch(documents, vendorData),
        this.runAml(person, vendorData),
      ]);

      const verdict = this.buildVerdict({
        actorId,
        runCount: (existingDidit?.run_count ?? 0) + 1,
        idResult,
        faceResult,
        amlResult,
        person,
      });

      await this.persistVerdict(kycApplicationId, kyc.screening ?? {}, verdict);
      await this.logOutcome(reviewId, kycApplicationId, actorId, actorRole, verdict);

      return { verdict, reused: false };
    } finally {
      this.inFlight.delete(kycApplicationId);
    }
  }

  // ── Documentos ──────────────────────────────────────────────────────

  private async loadPersonDocuments(userId: string): Promise<Map<string, StoredDocument>> {
    const { data: docs } = await this.supabase
      .from('documents')
      .select('document_type, storage_path, mime_type, file_size_bytes')
      .eq('user_id', userId)
      .eq('subject_type', 'person')
      .neq('status', 'superseded')
      .order('created_at', { ascending: false });

    const byType = new Map<string, StoredDocument>();
    for (const doc of docs ?? []) {
      if (!byType.has(doc.document_type)) byType.set(doc.document_type, doc);
    }
    return byType;
  }

  private async downloadAsBuffer(storagePath: string): Promise<Buffer | null> {
    const { data, error } = await this.supabase.storage
      .from(STORAGE_BUCKET)
      .download(storagePath);

    if (error || !data) {
      this.logger.warn(`No se pudo descargar documento de Didit: ${error?.message}`);
      return null;
    }
    return Buffer.from(await data.arrayBuffer());
  }

  private async toDiditFile(
    doc: StoredDocument,
    maxBytes: number,
  ): Promise<DiditFile | null> {
    if (doc.file_size_bytes && doc.file_size_bytes > maxBytes) {
      this.logger.warn(
        `Documento ${doc.storage_path} excede el límite de Didit (${doc.file_size_bytes} > ${maxBytes})`,
      );
      return null;
    }
    const buffer = await this.downloadAsBuffer(doc.storage_path);
    if (!buffer) return null;
    return {
      buffer,
      filename: doc.storage_path.split('/').pop() ?? doc.document_type,
      mimeType: doc.mime_type,
    };
  }

  private pickFirst(
    documents: Map<string, StoredDocument>,
    priority: string[],
  ): StoredDocument | undefined {
    for (const type of priority) {
      const doc = documents.get(type);
      if (doc) return doc;
    }
    return undefined;
  }

  // ── id-verification ──────────────────────────────────────────────

  private async runIdVerification(
    documents: Map<string, StoredDocument>,
    vendorData: string,
  ): Promise<DiditIdVerificationRaw | { skipped: string }> {
    const frontDoc = this.pickFirst(documents, DIDIT_DOC_TYPE_FRONT_PRIORITY);
    if (!frontDoc) return { skipped: 'Sin documento de identidad para verificar' };

    const frontImage = await this.toDiditFile(frontDoc, DIDIT_ID_VERIFICATION_MAX_BYTES);
    if (!frontImage) return { skipped: 'No se pudo descargar el documento de identidad' };

    const backType = DIDIT_DOC_TYPE_BACK_MAP[frontDoc.document_type];
    const backDoc = backType ? documents.get(backType) : undefined;
    const backImage = backDoc
      ? (await this.toDiditFile(backDoc, DIDIT_ID_VERIFICATION_MAX_BYTES)) ?? undefined
      : undefined;

    return this.diditApiClient.verifyId({ frontImage, backImage, vendorData });
  }

  // ── face-match ────────────────────────────────────────────────────

  private async runFaceMatch(
    documents: Map<string, StoredDocument>,
    vendorData: string,
  ): Promise<DiditFaceMatchRaw | { skipped: string }> {
    const selfieDoc = documents.get(DIDIT_SELFIE_DOC_TYPE);
    if (!selfieDoc) return { skipped: 'Sin selfie para comparar' };

    const refDoc = this.pickFirst(documents, DIDIT_FACE_MATCH_REF_PRIORITY);
    if (!refDoc) {
      return {
        skipped:
          'Sin documento de identidad en formato imagen (el pasaporte en PDF no es apto para face-match)',
      };
    }
    if (!DIDIT_FACE_MATCH_ACCEPTED_MIME.has(refDoc.mime_type)) {
      return { skipped: `Formato de documento no apto para face-match: ${refDoc.mime_type}` };
    }

    const userImage = await this.toDiditFile(selfieDoc, DIDIT_FACE_MATCH_MAX_BYTES);
    const refImage = await this.toDiditFile(refDoc, DIDIT_FACE_MATCH_MAX_BYTES);
    if (!userImage || !refImage) {
      return { skipped: 'No se pudieron descargar las imágenes para face-match' };
    }

    return this.diditApiClient.matchFaces({
      userImage,
      refImage,
      threshold: DIDIT_FACE_MATCH_DECLINE_THRESHOLD,
      vendorData,
    });
  }

  // ── AML ───────────────────────────────────────────────────────────

  private async runAml(
    person: {
      first_name: string | null;
      middle_name: string | null;
      last_name: string | null;
      date_of_birth: string | null;
      nationality: string | null;
      id_number: string | null;
    },
    vendorData: string,
  ): Promise<DiditAmlRaw | { skipped: string }> {
    const fullName = [person.first_name, person.middle_name, person.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (fullName.length < 2) {
      return { skipped: 'Nombre completo insuficiente para el screening AML' };
    }

    // people.nationality se guarda en alpha-3; el AML de Didit exige alpha-2.
    // Si el código no está en el mapa, se omite el campo en vez de mandar
    // un valor inválido (Didit responde 400 ante un alpha-3).
    const nationality = person.nationality
      ? ALPHA3_TO_ALPHA2[person.nationality.toUpperCase()]
      : undefined;

    return this.diditApiClient.screenAml({
      fullName,
      dateOfBirth: person.date_of_birth ?? undefined,
      nationality,
      documentNumber: person.id_number ?? undefined,
      vendorData,
    });
  }

  // ── Veredicto consolidado ─────────────────────────────────────────

  private buildVerdict(input: {
    actorId: string;
    runCount: number;
    idResult: PromiseSettledResult<DiditIdVerificationRaw | { skipped: string }>;
    faceResult: PromiseSettledResult<DiditFaceMatchRaw | { skipped: string }>;
    amlResult: PromiseSettledResult<DiditAmlRaw | { skipped: string }>;
    person: {
      first_name: string | null;
      last_name: string | null;
      date_of_birth: string | null;
      id_number: string | null;
    };
  }): DiditVerdict {
    const errors: Array<{ check: string; message: string }> = [];

    // id_verification
    let idVerification: DiditVerdict['id_verification'] = null;
    if (input.idResult.status === 'fulfilled') {
      const value = input.idResult.value;
      if ('skipped' in value) {
        idVerification = {
          status: 'Skipped',
          warnings: [],
          mismatches: [],
        };
      } else {
        const v = value.id_verification;
        const mismatches: string[] = [];
        if (
          v.first_name &&
          input.person.first_name &&
          v.first_name.trim().toLowerCase() !== input.person.first_name.trim().toLowerCase()
        ) {
          mismatches.push('first_name');
        }
        if (
          v.last_name &&
          input.person.last_name &&
          v.last_name.trim().toLowerCase() !== input.person.last_name.trim().toLowerCase()
        ) {
          mismatches.push('last_name');
        }
        if (
          v.date_of_birth &&
          input.person.date_of_birth &&
          v.date_of_birth !== input.person.date_of_birth
        ) {
          mismatches.push('date_of_birth');
        }
        if (
          v.document_number &&
          input.person.id_number &&
          v.document_number.trim() !== input.person.id_number.trim()
        ) {
          mismatches.push('document_number');
        }

        idVerification = {
          status: v.status,
          request_id: value.request_id,
          document_number_last4: v.document_number
            ? v.document_number.slice(-4)
            : undefined,
          first_name: v.first_name,
          last_name: v.last_name,
          date_of_birth: v.date_of_birth,
          nationality: v.nationality,
          warnings: (v.warnings ?? []).map((w) => ({
            code: w.code,
            description: w.description,
          })),
          mismatches,
        };
      }
    } else {
      errors.push({ check: 'id_verification', message: input.idResult.reason?.message ?? 'Error desconocido' });
    }

    // face_match
    let faceMatch: DiditVerdict['face_match'] = null;
    if (input.faceResult.status === 'fulfilled') {
      const value = input.faceResult.value;
      if ('skipped' in value) {
        faceMatch = { status: 'Skipped', warnings: [], skip_reason: value.skipped };
      } else {
        const v = value.face_match;
        faceMatch = {
          status: v.status,
          request_id: value.request_id,
          score: v.score,
          warnings: (v.warnings ?? []).map((w) => ({
            code: w.code,
            description: w.description,
          })),
        };
      }
    } else {
      errors.push({ check: 'face_match', message: input.faceResult.reason?.message ?? 'Error desconocido' });
    }

    // aml
    let aml: DiditVerdict['aml'] = null;
    if (input.amlResult.status === 'fulfilled') {
      const value = input.amlResult.value;
      if ('skipped' in value) {
        aml = { status: 'Skipped', warnings: [], hits_summary: [] };
      } else {
        const v = value.aml;
        aml = {
          status: v.status,
          request_id: value.request_id,
          score: v.score,
          total_hits: v.total_hits,
          hits_summary: (v.hits ?? []).map((h) => ({
            name: h.name,
            type: h.type,
            source: h.source,
          })),
          warnings: (v.warnings ?? []).map((w) => ({
            code: w.code,
            description: w.description,
          })),
        };
      }
    } else {
      errors.push({ check: 'aml', message: input.amlResult.reason?.message ?? 'Error desconocido' });
    }

    // 'error' solo cuando las tres llamadas fallaron de verdad (red, timeout,
    // sin crédito, Didit no configurado). Con un fallo parcial el veredicto
    // NUNCA puede ser 'approved': el staff vería un badge verde sin que la
    // comprobación fallida se haya ejecutado — p. ej. "aprobado" sin que el
    // screening de sanciones haya corrido. Lo mismo aplica a un 'Skipped':
    // 'approved' exige que las tres comprobaciones hayan corrido y pasado.
    const results = [idVerification, faceMatch, aml];

    let overall: DiditVerdict['overall'];
    if (errors.length === 3) {
      overall = 'error';
    } else if (results.some((r) => r?.status === 'Declined')) {
      overall = 'declined';
    } else if (results.every((r) => r?.status === 'Approved')) {
      overall = 'approved';
    } else {
      overall = 'needs_review';
    }

    return {
      schema_version: 1,
      overall,
      run_at: new Date().toISOString(),
      run_by: input.actorId,
      run_count: input.runCount,
      threshold_used: DIDIT_FACE_MATCH_DECLINE_THRESHOLD,
      id_verification: idVerification,
      face_match: faceMatch,
      aml,
      errors,
    };
  }

  // ── Persistencia ──────────────────────────────────────────────────

  private async persistVerdict(
    kycApplicationId: string,
    currentScreening: Record<string, unknown>,
    verdict: DiditVerdict,
  ): Promise<void> {
    const mergedScreening = { ...currentScreening, didit: verdict };
    const { error } = await this.supabase
      .from('kyc_applications')
      .update({ screening: mergedScreening })
      .eq('id', kycApplicationId);

    if (error) {
      this.logger.error(`No se pudo persistir el veredicto de Didit: ${error.message}`);
    }
  }

  private async logOutcome(
    reviewId: string,
    kycApplicationId: string,
    actorId: string,
    actorRole: string,
    verdict: DiditVerdict,
  ): Promise<void> {
    await this.supabase.from('compliance_review_events').insert({
      review_id: reviewId,
      actor_id: actorId,
      decision: 'DIDIT_VERIFIED',
      reason: `Resultado Didit: ${verdict.overall}`,
    });

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: 'DIDIT_VERIFICATION',
      table_name: 'kyc_applications',
      record_id: kycApplicationId,
      new_values: { overall: verdict.overall, run_count: verdict.run_count },
      source: 'admin_panel',
    });
  }
}

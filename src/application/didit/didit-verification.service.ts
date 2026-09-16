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
  DIDIT_DATABASE_VALIDATION_SERVICES,
  DIDIT_DOC_TYPE_BACK_MAP,
  DIDIT_DOC_TYPE_FRONT_PRIORITY,
  DIDIT_FACE_MATCH_ACCEPTED_MIME,
  DIDIT_FACE_MATCH_DECLINE_THRESHOLD,
  DIDIT_FACE_MATCH_MAX_BYTES,
  DIDIT_FACE_MATCH_REF_PRIORITY,
  DIDIT_ID_VERIFICATION_MAX_BYTES,
  DIDIT_LIVENESS_DECLINE_THRESHOLD,
  DIDIT_LIVENESS_MAX_BYTES,
  DIDIT_POA_DOC_TYPE,
  DIDIT_POA_MAX_BYTES,
  DIDIT_SELFIE_DOC_TYPE,
} from './didit.constants';
import {
  DiditAmlRaw,
  DiditCheckStatus,
  DiditDatabaseValidationRaw,
  DiditDatabaseValidationResult,
  DiditFaceMatchRaw,
  DiditFile,
  DiditIdVerificationRaw,
  DiditKeyPersonResult,
  DiditLivenessRaw,
  DiditLivenessResult,
  DiditPoaRaw,
  DiditPoaResult,
  DiditVerdict,
} from './didit.types';

const STORAGE_BUCKET = 'kyc-documents';

interface StoredDocument {
  document_type: string;
  storage_path: string;
  mime_type: string;
  file_size_bytes: number | null;
}

/** Datos mínimos de una persona (KYC, director o UBO) para AML / Database Validation / mismatches. */
interface PersonLike {
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  date_of_birth?: string | null;
  nationality?: string | null;
  id_number?: string | null;
}

/** Resultado consolidado de las 5 comprobaciones que corren por persona (KYC, director o cada UBO). */
interface PersonCheckBundle {
  id_verification: DiditVerdict['id_verification'];
  face_match: DiditVerdict['face_match'];
  aml: DiditVerdict['aml'];
  database_validation: DiditDatabaseValidationResult | null;
  liveness: DiditLivenessResult | null;
  errors: Array<{ check: string; message: string }>;
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

    if (review.subject_type === 'kyc_applications') {
      return this.runForKycReview(reviewId, review.subject_id, actorId, actorRole, force);
    }
    if (review.subject_type === 'kyb_applications') {
      return this.runForKybReview(reviewId, review.subject_id, actorId, actorRole, force);
    }

    throw new BadRequestException(
      `La pre-verificación con Didit no está soportada para el tipo de expediente: ${review.subject_type}`,
    );
  }

  // ── KYC (Personas) ───────────────────────────────────────────────────

  private async runForKycReview(
    reviewId: string,
    kycApplicationId: string,
    actorId: string,
    actorRole: string,
    force: boolean,
  ): Promise<{ verdict: DiditVerdict; reused: boolean }> {
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

      const [idResult, faceResult, amlResult, dbResult, livenessResult, poaResult] =
        await Promise.allSettled([
          this.runIdVerification(documents, vendorData),
          this.runFaceMatch(documents, vendorData),
          this.runAml(person, vendorData),
          this.runDatabaseValidation(person, vendorData),
          this.runLiveness(documents, vendorData),
          this.runProofOfAddress(documents, person, vendorData),
        ]);

      const verdict = this.buildVerdict({
        actorId,
        runCount: (existingDidit?.run_count ?? 0) + 1,
        idResult,
        faceResult,
        amlResult,
        dbResult,
        livenessResult,
        poaResult,
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

  /**
   * Documentos de una persona/entidad dentro de un KYB: director, UBO o la
   * propia empresa. Director y UBO llevan `subject_id` (varias personas
   * comparten `user_id` — el solicitante que sube todo); la empresa no lo
   * necesita porque solo hay una por solicitante, así que `subjectId` es
   * opcional y se omite ese filtro cuando no se pasa.
   */
  private async loadKybDocuments(
    userId: string,
    subjectType: string,
    subjectId?: string,
  ): Promise<Map<string, StoredDocument>> {
    let query = this.supabase
      .from('documents')
      .select('document_type, storage_path, mime_type, file_size_bytes')
      .eq('user_id', userId)
      .eq('subject_type', subjectType)
      .neq('status', 'superseded')
      .order('created_at', { ascending: false });

    if (subjectId) {
      query = query.eq('subject_id', subjectId);
    }

    const { data: docs } = await query;

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
    person: PersonLike,
    vendorData: string,
  ): Promise<DiditAmlRaw | { skipped: string }> {
    const fullName = [person.first_name, person.middle_name, person.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (fullName.length < 2) {
      return { skipped: 'Nombre completo insuficiente para el screening AML' };
    }

    const rawCountry = (person.nationality ?? '').trim().toUpperCase();
    const nationality = rawCountry
      ? (ALPHA3_TO_ALPHA2[rawCountry] ?? (rawCountry.length === 2 ? rawCountry : undefined))
      : undefined;

    return this.diditApiClient.screenAml({
      fullName,
      entityType: 'person',
      dateOfBirth: person.date_of_birth ?? undefined,
      nationality,
      documentNumber: person.id_number ?? undefined,
      vendorData,
    });
  }

  private async runCompanyAml(
    business: {
      legal_name: string | null;
      trade_name?: string | null;
      tax_id: string | null;
      registration_number?: string | null;
      country?: string | null;
      country_of_incorporation?: string | null;
      incorporation_date?: string | null;
    },
    vendorData: string,
  ): Promise<DiditAmlRaw | { skipped: string }> {
    const companyName = (business.legal_name || business.trade_name || '').trim();
    if (companyName.length < 2) {
      return { skipped: 'Nombre de empresa insuficiente para el screening AML' };
    }

    const rawCountry = (business.country || business.country_of_incorporation || '').trim().toUpperCase();
    const nationality = rawCountry
      ? (ALPHA3_TO_ALPHA2[rawCountry] ?? (rawCountry.length === 2 ? rawCountry : undefined))
      : undefined;
    const documentNumber = (business.tax_id || business.registration_number || '').trim() || undefined;

    return this.diditApiClient.screenAml({
      fullName: companyName,
      entityType: 'company',
      dateOfBirth: business.incorporation_date ?? undefined,
      nationality,
      documentNumber,
      vendorData,
    });
  }

  // ── Database Validation (registro gubernamental — SEGIP en Bolivia) ──

  /**
   * Confirma contra el registro civil del país que el documento de
   * identidad existe de verdad — a diferencia de id-verification, que solo
   * confirma que el documento *parece* válido (OCR). Un documento clonado
   * puede pasar el OCR y aun así no existir en el registro.
   */
  private async runDatabaseValidation(
    person: PersonLike,
    vendorData: string,
  ): Promise<DiditDatabaseValidationRaw | { skipped: string }> {
    const country = (person.nationality ?? '').trim().toUpperCase();
    const serviceId = DIDIT_DATABASE_VALIDATION_SERVICES[country];
    if (!serviceId) {
      return {
        skipped: `Sin cobertura de Database Validation para el país ${country || 'desconocido'}`,
      };
    }
    if (!person.id_number || !person.date_of_birth) {
      return { skipped: 'Faltan documento o fecha de nacimiento para Database Validation' };
    }

    return this.diditApiClient.verifyDatabase({
      issuingState: country,
      serviceId,
      documentNumber: person.id_number,
      dateOfBirth: person.date_of_birth,
      firstName: person.first_name ?? undefined,
      lastName: person.last_name ?? undefined,
      vendorData,
    });
  }

  // ── Liveness (anti-spoofing sobre la selfie) ─────────────────────────

  /**
   * Face Match solo compara dos fotos estáticas — no prueba que hubo una
   * persona real frente a la cámara. Liveness detecta deepfake, máscara o
   * una foto de una foto sobre la misma selfie que ya se sube para Face Match.
   */
  private async runLiveness(
    documents: Map<string, StoredDocument>,
    vendorData: string,
  ): Promise<DiditLivenessRaw | { skipped: string }> {
    const selfieDoc = documents.get(DIDIT_SELFIE_DOC_TYPE);
    if (!selfieDoc) return { skipped: 'Sin selfie para liveness' };

    const userImage = await this.toDiditFile(selfieDoc, DIDIT_LIVENESS_MAX_BYTES);
    if (!userImage) return { skipped: 'No se pudo descargar la selfie para liveness' };

    return this.diditApiClient.checkLiveness({
      userImage,
      threshold: DIDIT_LIVENESS_DECLINE_THRESHOLD,
      vendorData,
    });
  }

  // ── Proof of Address ─────────────────────────────────────────────────

  /**
   * Guira ya exige el comprobante de domicilio en el onboarding (persona y
   * empresa) pero hasta ahora solo lo veía un humano en revisión. Valida
   * emisor, vigencia y manipulación del documento antes de que llegue ahí.
   * `person` es opcional: a nivel empresa no hay nombre de persona contra
   * el cual cotejar, solo se valida el documento en sí.
   */
  private async runProofOfAddress(
    documents: Map<string, StoredDocument>,
    person: PersonLike | null,
    vendorData: string,
  ): Promise<DiditPoaRaw | { skipped: string }> {
    const poaDoc = documents.get(DIDIT_POA_DOC_TYPE);
    if (!poaDoc) return { skipped: 'Sin comprobante de domicilio para validar' };

    const document = await this.toDiditFile(poaDoc, DIDIT_POA_MAX_BYTES);
    if (!document) return { skipped: 'No se pudo descargar el comprobante de domicilio' };

    return this.diditApiClient.verifyProofOfAddress({
      document,
      expectedFirstName: person?.first_name ?? undefined,
      expectedLastName: person?.last_name ?? undefined,
      vendorData,
    });
  }

  // ── Construcción de resultados compartida (KYC + KYB) ────────────────

  /**
   * Mapea los 5 resultados crudos de una persona (id_verification, face_match,
   * aml, database_validation, liveness) al formato del veredicto, con los
   * mismatches de id_verification contra los datos que Guira ya tiene.
   * Usado tanto para la persona de KYC como para el representante y cada
   * UBO de KYB — antes esta lógica estaba triplicada.
   */
  private buildPersonResult(input: {
    checkPrefix: string;
    idResult: PromiseSettledResult<DiditIdVerificationRaw | { skipped: string }>;
    faceResult: PromiseSettledResult<DiditFaceMatchRaw | { skipped: string }>;
    amlResult: PromiseSettledResult<DiditAmlRaw | { skipped: string }>;
    dbResult: PromiseSettledResult<DiditDatabaseValidationRaw | { skipped: string }>;
    livenessResult: PromiseSettledResult<DiditLivenessRaw | { skipped: string }>;
    referencePerson: PersonLike | null;
  }): PersonCheckBundle {
    const errors: Array<{ check: string; message: string }> = [];
    const prefix = input.checkPrefix;
    const ref = input.referencePerson;

    // id_verification
    let idVerification: DiditVerdict['id_verification'] = null;
    if (input.idResult.status === 'fulfilled') {
      const value = input.idResult.value;
      if ('skipped' in value) {
        idVerification = { status: 'Skipped', warnings: [], mismatches: [] };
      } else {
        const v = value.id_verification;
        const mismatches: string[] = [];
        if (
          v.first_name &&
          ref?.first_name &&
          v.first_name.trim().toLowerCase() !== ref.first_name.trim().toLowerCase()
        ) {
          mismatches.push('first_name');
        }
        if (
          v.last_name &&
          ref?.last_name &&
          v.last_name.trim().toLowerCase() !== ref.last_name.trim().toLowerCase()
        ) {
          mismatches.push('last_name');
        }
        if (v.date_of_birth && ref?.date_of_birth && v.date_of_birth !== ref.date_of_birth) {
          mismatches.push('date_of_birth');
        }
        if (
          v.document_number &&
          ref?.id_number &&
          v.document_number.trim() !== ref.id_number.trim()
        ) {
          mismatches.push('document_number');
        }

        idVerification = {
          status: v.status,
          request_id: value.request_id,
          document_number_last4: v.document_number ? v.document_number.slice(-4) : undefined,
          first_name: v.first_name,
          last_name: v.last_name,
          date_of_birth: v.date_of_birth,
          nationality: v.nationality,
          warnings: (v.warnings ?? []).map((w) => ({ code: w.code, description: w.description })),
          mismatches,
        };
      }
    } else {
      errors.push({
        check: `${prefix}id_verification`,
        message: input.idResult.reason?.message ?? 'Error desconocido',
      });
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
          warnings: (v.warnings ?? []).map((w) => ({ code: w.code, description: w.description })),
        };
      }
    } else {
      errors.push({
        check: `${prefix}face_match`,
        message: input.faceResult.reason?.message ?? 'Error desconocido',
      });
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
          hits_summary: (v.hits ?? []).map((h) => ({ name: h.name, type: h.type, source: h.source })),
          warnings: (v.warnings ?? []).map((w) => ({ code: w.code, description: w.description })),
        };
      }
    } else {
      errors.push({
        check: `${prefix}aml`,
        message: input.amlResult.reason?.message ?? 'Error desconocido',
      });
    }

    // database_validation
    let databaseValidation: DiditDatabaseValidationResult | null = null;
    if (input.dbResult.status === 'fulfilled') {
      const value = input.dbResult.value;
      if ('skipped' in value) {
        databaseValidation = { status: 'Skipped', warnings: [], skip_reason: value.skipped };
      } else {
        const v = value.database_validation;
        databaseValidation = {
          status: v.status,
          request_id: value.request_id,
          match_type: v.match_type,
          warnings: [],
        };
      }
    } else {
      errors.push({
        check: `${prefix}database_validation`,
        message: input.dbResult.reason?.message ?? 'Error desconocido',
      });
    }

    // liveness
    let liveness: DiditLivenessResult | null = null;
    if (input.livenessResult.status === 'fulfilled') {
      const value = input.livenessResult.value;
      if ('skipped' in value) {
        liveness = { status: 'Skipped', warnings: [], skip_reason: value.skipped };
      } else {
        const v = value.liveness;
        liveness = {
          status: v.status,
          request_id: value.request_id,
          score: v.score,
          warnings: (v.warnings ?? []).map((w) => ({ code: w.code, description: w.description })),
        };
      }
    } else {
      errors.push({
        check: `${prefix}liveness`,
        message: input.livenessResult.reason?.message ?? 'Error desconocido',
      });
    }

    return { id_verification: idVerification, face_match: faceMatch, aml, database_validation: databaseValidation, liveness, errors };
  }

  private mapPoaResult(
    result: PromiseSettledResult<DiditPoaRaw | { skipped: string }>,
    checkName: string,
    errors: Array<{ check: string; message: string }>,
  ): DiditPoaResult | null {
    if (result.status === 'fulfilled') {
      const value = result.value;
      if ('skipped' in value) {
        return { status: 'Skipped', warnings: [], skip_reason: value.skipped };
      }
      const v = value.poa;
      return {
        status: v.status,
        request_id: value.request_id,
        issuer: v.issuer,
        warnings: (v.warnings ?? []).map((w) => ({ code: w.code, description: w.description })),
      };
    }
    errors.push({ check: checkName, message: result.reason?.message ?? 'Error desconocido' });
    return null;
  }

  /**
   * Regla única para todo el veredicto (KYC y KYB): 'approved' exige que
   * absolutamente todos los resultados sean 'Approved' — ni un Skipped ni
   * un error (null, promesa rechazada de verdad) cuelan. 'error' es el
   * extremo opuesto: nada pudo evaluarse. Cualquier otra combinación es
   * 'needs_review' — la señal correcta para que decida un humano, nunca un
   * rechazo automático ni una aprobación con huecos.
   */
  private computeOverall(
    results: Array<{ status: DiditCheckStatus } | null>,
    errorsCount: number,
  ): DiditVerdict['overall'] {
    if (errorsCount > 0 && results.every((r) => r === null)) return 'error';
    if (results.some((r) => r?.status === 'Declined')) return 'declined';
    if (results.every((r) => r?.status === 'Approved')) return 'approved';
    return 'needs_review';
  }

  // ── Veredicto consolidado — KYC ───────────────────────────────────

  private buildVerdict(input: {
    actorId: string;
    runCount: number;
    idResult: PromiseSettledResult<DiditIdVerificationRaw | { skipped: string }>;
    faceResult: PromiseSettledResult<DiditFaceMatchRaw | { skipped: string }>;
    amlResult: PromiseSettledResult<DiditAmlRaw | { skipped: string }>;
    dbResult: PromiseSettledResult<DiditDatabaseValidationRaw | { skipped: string }>;
    livenessResult: PromiseSettledResult<DiditLivenessRaw | { skipped: string }>;
    poaResult: PromiseSettledResult<DiditPoaRaw | { skipped: string }>;
    person: PersonLike;
  }): DiditVerdict {
    const bundle = this.buildPersonResult({
      checkPrefix: '',
      idResult: input.idResult,
      faceResult: input.faceResult,
      amlResult: input.amlResult,
      dbResult: input.dbResult,
      livenessResult: input.livenessResult,
      referencePerson: input.person,
    });

    const errors = [...bundle.errors];
    const proofOfAddress = this.mapPoaResult(input.poaResult, 'proof_of_address', errors);

    const allResults = [
      bundle.id_verification,
      bundle.face_match,
      bundle.aml,
      bundle.database_validation,
      bundle.liveness,
      proofOfAddress,
    ];
    const overall = this.computeOverall(allResults, errors.length);

    return {
      schema_version: 1,
      overall,
      run_at: new Date().toISOString(),
      run_by: input.actorId,
      run_count: input.runCount,
      threshold_used: DIDIT_FACE_MATCH_DECLINE_THRESHOLD,
      id_verification: bundle.id_verification,
      face_match: bundle.face_match,
      aml: bundle.aml,
      database_validation: bundle.database_validation,
      liveness: bundle.liveness,
      proof_of_address: proofOfAddress,
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

  // ── KYB (Empresas) ──────────────────────────────────────────────────

  private async runForKybReview(
    reviewId: string,
    kybApplicationId: string,
    actorId: string,
    actorRole: string,
    force: boolean,
  ): Promise<{ verdict: DiditVerdict; reused: boolean }> {
    if (this.inFlight.has(kybApplicationId)) {
      throw new ConflictException(
        'Ya hay una verificación de Didit en curso para este expediente.',
      );
    }
    this.inFlight.add(kybApplicationId);

    try {
      const { data: kyb } = await this.supabase
        .from('kyb_applications')
        .select('id, business_id, requester_user_id, screening')
        .eq('id', kybApplicationId)
        .single();

      if (!kyb) throw new NotFoundException('Expediente KYB no encontrado');

      const existingDidit = kyb.screening?.didit as DiditVerdict | undefined;
      if (existingDidit && !force) {
        return { verdict: existingDidit, reused: true };
      }

      if (!kyb.business_id) {
        throw new BadRequestException(
          'El expediente no tiene una empresa asociada (business_id vacío).',
        );
      }

      const { data: business } = await this.supabase
        .from('businesses')
        .select('*, business_directors(*), business_ubos(*)')
        .eq('id', kyb.business_id)
        .single();

      if (!business) throw new NotFoundException('Datos de la empresa no encontrados');

      const companyVendorData = `guira:kyb:${kybApplicationId}:company`;

      // 1. Empresa: AML + Proof of Address (el comprobante de domicilio del
      // negocio, subject_type='business' — sin subject_id porque solo hay
      // una empresa por solicitante).
      const companyAmlPromise = this.runCompanyAml(business, companyVendorData);
      const companyDocuments = await this.loadKybDocuments(kyb.requester_user_id, 'business');
      const companyPoaPromise = this.runProofOfAddress(companyDocuments, null, companyVendorData);

      // 2. Representante legal: las 5 comprobaciones, igual que una persona
      // de KYC. Un negocio puede tener varios directores compartiendo
      // user_id — se acota a subject_type='director' + subject_id.
      const directors = (business.business_directors ?? []) as any[];
      const primaryDirector = directors.find((d: any) => d.is_signer) ?? directors[0] ?? null;

      const directorDocuments = primaryDirector
        ? await this.loadKybDocuments(kyb.requester_user_id, 'director', primaryDirector.id)
        : new Map<string, StoredDocument>();

      let directorAmlPromise: Promise<DiditAmlRaw | { skipped: string }> = Promise.resolve({
        skipped: 'Sin representante legal registrado',
      });
      let directorIdPromise: Promise<DiditIdVerificationRaw | { skipped: string }> = Promise.resolve({
        skipped: 'Sin representante legal registrado',
      });
      let directorFacePromise: Promise<DiditFaceMatchRaw | { skipped: string }> = Promise.resolve({
        skipped: 'Sin representante legal registrado',
      });
      let directorDbPromise: Promise<DiditDatabaseValidationRaw | { skipped: string }> = Promise.resolve({
        skipped: 'Sin representante legal registrado',
      });
      let directorLivenessPromise: Promise<DiditLivenessRaw | { skipped: string }> = Promise.resolve({
        skipped: 'Sin representante legal registrado',
      });

      if (primaryDirector) {
        const directorVendorData = `guira:kyb:${kybApplicationId}:director:${primaryDirector.id}`;
        directorAmlPromise = this.runAml(primaryDirector, directorVendorData);
        directorIdPromise = this.runIdVerification(directorDocuments, directorVendorData);
        directorFacePromise = this.runFaceMatch(directorDocuments, directorVendorData);
        directorDbPromise = this.runDatabaseValidation(primaryDirector, directorVendorData);
        directorLivenessPromise = this.runLiveness(directorDocuments, directorVendorData);
      }

      // 3. Cada UBO: las mismas 5 comprobaciones que el representante — ya
      // no solo AML. Guira recolecta selfie + documento de cada UBO
      // (subject_type='ubo' + su propio subject_id); antes ese material se
      // subía y nunca se usaba para nada más que el screening de sanciones.
      const ubos = (business.business_ubos ?? []) as any[];
      const ubosDocuments = await Promise.all(
        ubos.map((ubo) => this.loadKybDocuments(kyb.requester_user_id, 'ubo', ubo.id)),
      );

      const uboChecksPromises = ubos.flatMap((ubo, index) => {
        const uboVendorData = `guira:kyb:${kybApplicationId}:ubo:${ubo.id}`;
        const uboDocuments = ubosDocuments[index];
        return [
          this.runAml(ubo, uboVendorData),
          this.runIdVerification(uboDocuments, uboVendorData),
          this.runFaceMatch(uboDocuments, uboVendorData),
          this.runDatabaseValidation(ubo, uboVendorData),
          this.runLiveness(uboDocuments, uboVendorData),
        ];
      });

      // Ejecutar todo en paralelo: empresa (2) + representante (5) + N UBOs (5 c/u).
      const [
        companyAmlResult,
        companyPoaResult,
        directorAmlResult,
        directorIdResult,
        directorFaceResult,
        directorDbResult,
        directorLivenessResult,
        ...uboChecksSettled
      ] = await Promise.allSettled([
        companyAmlPromise,
        companyPoaPromise,
        directorAmlPromise,
        directorIdPromise,
        directorFacePromise,
        directorDbPromise,
        directorLivenessPromise,
        ...uboChecksPromises,
      ]);

      // Reagrupar los 5 resultados de cada UBO (mismo orden en que se lanzaron).
      const ubosSettledGroups = ubos.map((ubo, index) => ({
        ubo,
        amlResult: uboChecksSettled[index * 5] as PromiseSettledResult<DiditAmlRaw | { skipped: string }>,
        idResult: uboChecksSettled[index * 5 + 1] as PromiseSettledResult<DiditIdVerificationRaw | { skipped: string }>,
        faceResult: uboChecksSettled[index * 5 + 2] as PromiseSettledResult<DiditFaceMatchRaw | { skipped: string }>,
        dbResult: uboChecksSettled[index * 5 + 3] as PromiseSettledResult<DiditDatabaseValidationRaw | { skipped: string }>,
        livenessResult: uboChecksSettled[index * 5 + 4] as PromiseSettledResult<DiditLivenessRaw | { skipped: string }>,
      }));

      const verdict = this.buildKybVerdict({
        actorId,
        runCount: (existingDidit?.run_count ?? 0) + 1,
        companyAmlResult,
        companyPoaResult,
        directorAmlResult,
        directorIdResult,
        directorFaceResult,
        directorDbResult,
        directorLivenessResult,
        ubosSettledGroups,
        primaryDirector,
        business,
      });

      await this.persistKybVerdict(kybApplicationId, kyb.screening ?? {}, verdict);
      await this.logKybOutcome(reviewId, kybApplicationId, actorId, actorRole, verdict);

      return { verdict, reused: false };
    } finally {
      this.inFlight.delete(kybApplicationId);
    }
  }

  private buildKybVerdict(input: {
    actorId: string;
    runCount: number;
    companyAmlResult: PromiseSettledResult<DiditAmlRaw | { skipped: string }>;
    companyPoaResult: PromiseSettledResult<DiditPoaRaw | { skipped: string }>;
    directorAmlResult: PromiseSettledResult<DiditAmlRaw | { skipped: string }>;
    directorIdResult: PromiseSettledResult<DiditIdVerificationRaw | { skipped: string }>;
    directorFaceResult: PromiseSettledResult<DiditFaceMatchRaw | { skipped: string }>;
    directorDbResult: PromiseSettledResult<DiditDatabaseValidationRaw | { skipped: string }>;
    directorLivenessResult: PromiseSettledResult<DiditLivenessRaw | { skipped: string }>;
    ubosSettledGroups: Array<{
      ubo: any;
      amlResult: PromiseSettledResult<DiditAmlRaw | { skipped: string }>;
      idResult: PromiseSettledResult<DiditIdVerificationRaw | { skipped: string }>;
      faceResult: PromiseSettledResult<DiditFaceMatchRaw | { skipped: string }>;
      dbResult: PromiseSettledResult<DiditDatabaseValidationRaw | { skipped: string }>;
      livenessResult: PromiseSettledResult<DiditLivenessRaw | { skipped: string }>;
    }>;
    primaryDirector: any | null;
    business: any;
  }): DiditVerdict {
    const errors: Array<{ check: string; message: string }> = [];

    // 1. Empresa: AML
    let companyAml: DiditVerdict['aml'] = null;
    if (input.companyAmlResult.status === 'fulfilled') {
      const value = input.companyAmlResult.value;
      if ('skipped' in value) {
        companyAml = { status: 'Skipped', warnings: [], hits_summary: [] };
      } else {
        const v = value.aml;
        companyAml = {
          status: v.status,
          request_id: value.request_id,
          score: v.score,
          total_hits: v.total_hits,
          hits_summary: (v.hits ?? []).map((h) => ({ name: h.name, type: h.type, source: h.source })),
          warnings: (v.warnings ?? []).map((w) => ({ code: w.code, description: w.description })),
        };
      }
    } else {
      errors.push({
        check: 'company_aml',
        message: input.companyAmlResult.reason?.message ?? 'Error desconocido',
      });
    }

    // 2. Empresa: Proof of Address
    const companyPoa = this.mapPoaResult(input.companyPoaResult, 'company_proof_of_address', errors);

    // 3. Representante legal — las 5 comprobaciones vía el builder compartido
    const directorBundle = this.buildPersonResult({
      checkPrefix: 'director_',
      idResult: input.directorIdResult,
      faceResult: input.directorFaceResult,
      amlResult: input.directorAmlResult,
      dbResult: input.directorDbResult,
      livenessResult: input.directorLivenessResult,
      referencePerson: input.primaryDirector,
    });
    errors.push(...directorBundle.errors);

    const keyPeople: DiditKeyPersonResult[] = [];
    if (input.primaryDirector) {
      keyPeople.push({
        id: input.primaryDirector.id,
        role: 'director',
        name: [input.primaryDirector.first_name, input.primaryDirector.last_name].filter(Boolean).join(' ') || 'Representante Legal',
        position: input.primaryDirector.position ?? 'Representante Legal',
        aml: directorBundle.aml,
        id_verification: directorBundle.id_verification,
        face_match: directorBundle.face_match,
        database_validation: directorBundle.database_validation,
        liveness: directorBundle.liveness,
      });
    }

    // 4. Cada UBO — mismas 5 comprobaciones
    const uboBundles: PersonCheckBundle[] = [];
    for (const group of input.ubosSettledGroups) {
      const bundle = this.buildPersonResult({
        checkPrefix: `ubo_${group.ubo.id}_`,
        idResult: group.idResult,
        faceResult: group.faceResult,
        amlResult: group.amlResult,
        dbResult: group.dbResult,
        livenessResult: group.livenessResult,
        referencePerson: group.ubo,
      });
      errors.push(...bundle.errors);
      uboBundles.push(bundle);

      keyPeople.push({
        id: group.ubo.id,
        role: 'ubo',
        name: [group.ubo.first_name, group.ubo.last_name].filter(Boolean).join(' ') || 'Beneficiario Final',
        position: group.ubo.position,
        percentage: typeof group.ubo.ownership_percent === 'number' ? group.ubo.ownership_percent : Number(group.ubo.ownership_percent) || undefined,
        aml: bundle.aml,
        id_verification: bundle.id_verification,
        face_match: bundle.face_match,
        database_validation: bundle.database_validation,
        liveness: bundle.liveness,
      });
    }

    // Evaluación global: empresa (AML + POA) + representante (5) + cada UBO (5).
    // Misma regla estricta que KYC — ver computeOverall.
    const allResults = [
      companyAml,
      companyPoa,
      directorBundle.id_verification,
      directorBundle.face_match,
      directorBundle.aml,
      directorBundle.database_validation,
      directorBundle.liveness,
      ...uboBundles.flatMap((b) => [b.id_verification, b.face_match, b.aml, b.database_validation, b.liveness]),
    ];
    const overall = this.computeOverall(allResults, errors.length);

    return {
      schema_version: 1,
      application_type: 'kyb',
      overall,
      run_at: new Date().toISOString(),
      run_by: input.actorId,
      run_count: input.runCount,
      threshold_used: DIDIT_FACE_MATCH_DECLINE_THRESHOLD,
      company_aml: companyAml,
      company_proof_of_address: companyPoa,
      key_people: keyPeople,
      id_verification: directorBundle.id_verification,
      face_match: directorBundle.face_match,
      database_validation: directorBundle.database_validation,
      liveness: directorBundle.liveness,
      aml: companyAml,
      errors,
    };
  }

  private async persistKybVerdict(
    kybApplicationId: string,
    currentScreening: Record<string, unknown>,
    verdict: DiditVerdict,
  ): Promise<void> {
    const mergedScreening = { ...currentScreening, didit: verdict };
    const { error } = await this.supabase
      .from('kyb_applications')
      .update({
        screening: mergedScreening,
        last_screened_at: new Date().toISOString(),
      })
      .eq('id', kybApplicationId);

    if (error) {
      this.logger.error(`No se pudo persistir el veredicto de Didit en KYB: ${error.message}`);
    }
  }

  private async logKybOutcome(
    reviewId: string,
    kybApplicationId: string,
    actorId: string,
    actorRole: string,
    verdict: DiditVerdict,
  ): Promise<void> {
    await this.supabase.from('compliance_review_events').insert({
      review_id: reviewId,
      actor_id: actorId,
      decision: 'DIDIT_VERIFIED',
      reason: `Resultado Didit KYB: ${verdict.overall}`,
    });

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: 'DIDIT_VERIFICATION',
      table_name: 'kyb_applications',
      record_id: kybApplicationId,
      new_values: { overall: verdict.overall, run_count: verdict.run_count },
      source: 'admin_panel',
    });
  }
}

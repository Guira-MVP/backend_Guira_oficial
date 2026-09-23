import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
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
  DIDIT_REUSE_APPROVED_MAX_AGE_DAYS,
  DIDIT_SELFIE_DOC_TYPE,
} from './didit.constants';
import {
  DiditAmlRaw,
  DiditAmlResult,
  DiditCheckMeta,
  DiditCheckStatus,
  DiditDatabaseValidationRaw,
  DiditDatabaseValidationResult,
  DiditFaceMatchRaw,
  DiditFaceMatchResult,
  DiditFile,
  DiditIdVerificationRaw,
  DiditIdVerificationResult,
  DiditKeyPersonResult,
  DiditLivenessRaw,
  DiditLivenessResult,
  DiditPoaRaw,
  DiditPoaResult,
  DiditVerdict,
  DiditVerdictWarning,
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

type Skipped = { skipped: string };
/** Resultado copiado de la corrida anterior, sin volver a llamar a Didit. */
type Reused<R> = { reused: R };
type Outcome<Raw, R> = Raw | Skipped | Reused<R>;

type IdOutcome = Outcome<DiditIdVerificationRaw, DiditIdVerificationResult>;
type FaceOutcome = Outcome<DiditFaceMatchRaw, DiditFaceMatchResult>;
type AmlOutcome = Outcome<DiditAmlRaw, DiditAmlResult>;
type DbOutcome = Outcome<DiditDatabaseValidationRaw, DiditDatabaseValidationResult>;
type LivenessOutcome = Outcome<DiditLivenessRaw, DiditLivenessResult>;
type PoaOutcome = Outcome<DiditPoaRaw, DiditPoaResult>;

/** Resultados de una persona en la corrida anterior (veredicto KYC o entrada de key_people). */
interface PersonPrevious {
  id_verification?: DiditIdVerificationResult | null;
  face_match?: DiditFaceMatchResult | null;
  aml?: DiditAmlResult | null;
  database_validation?: DiditDatabaseValidationResult | null;
  liveness?: DiditLivenessResult | null;
}

interface PersonFingerprints {
  id: string;
  face: string;
  aml: string;
  db: string;
  liveness: string;
}

/** Las 5 comprobaciones de una persona, ya lanzadas. */
interface PersonChecksLaunch {
  fingerprints: PersonFingerprints | null;
  id: Promise<IdOutcome>;
  face: Promise<FaceOutcome>;
  aml: Promise<AmlOutcome>;
  db: Promise<DbOutcome>;
  liveness: Promise<LivenessOutcome>;
}

interface PersonChecksSettled {
  fingerprints: PersonFingerprints | null;
  idResult: PromiseSettledResult<IdOutcome>;
  faceResult: PromiseSettledResult<FaceOutcome>;
  amlResult: PromiseSettledResult<AmlOutcome>;
  dbResult: PromiseSettledResult<DbOutcome>;
  livenessResult: PromiseSettledResult<LivenessOutcome>;
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

      // En una re-ejecución forzada, lo que ya salió Approved con las mismas
      // entradas se reutiliza en lugar de volver a pagarlo (ver canReuse).
      const personChecks = this.launchPersonChecks(
        documents,
        person,
        vendorData,
        existingDidit ?? null,
      );
      const poaFingerprint = this.poaFingerprint(documents, person);
      const poaPromise = this.reuseOr(existingDidit?.proof_of_address, poaFingerprint, () =>
        this.runProofOfAddress(documents, person, vendorData),
      );

      const [checks, poaResult] = await Promise.all([
        this.settlePersonChecks(personChecks),
        this.settle(poaPromise),
      ]);

      const verdict = this.buildVerdict({
        actorId,
        runCount: (existingDidit?.run_count ?? 0) + 1,
        checks,
        poaResult,
        poaFingerprint,
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

  // ── Reutilización en re-ejecuciones forzadas ─────────────────────────

  /**
   * Huella de las entradas de una comprobación. Si la huella guardada
   * coincide, Didit recibiría exactamente lo mismo que la vez anterior.
   */
  private fingerprint(parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  /**
   * Rutas de los documentos que alimentan una comprobación. Un documento
   * re-subido tiene otra `storage_path`, así que cambia la huella.
   */
  private docPaths(
    documents: Map<string, StoredDocument>,
    types: string[],
  ): Array<string | null> {
    return types.map((type) => documents.get(type)?.storage_path ?? null);
  }

  private normalize(value: unknown): string {
    return (value ?? '').toString().trim().toLowerCase();
  }

  private personKey(person: PersonLike | null): string[] {
    const p: PersonLike = person ?? {};
    return [
      p.first_name,
      p.middle_name,
      p.last_name,
      p.date_of_birth,
      p.nationality,
      p.id_number,
    ].map((v) => this.normalize(v));
  }

  private personFingerprints(
    documents: Map<string, StoredDocument>,
    person: PersonLike,
  ): PersonFingerprints {
    const who = this.personKey(person);
    return {
      // id_verification depende también de la persona: los mismatches se
      // calculan contra sus datos, y reutilizarlos con datos nuevos mentiría.
      id: this.fingerprint([
        'id_verification',
        this.docPaths(documents, [
          ...DIDIT_DOC_TYPE_FRONT_PRIORITY,
          ...Object.values(DIDIT_DOC_TYPE_BACK_MAP),
        ]),
        who,
      ]),
      face: this.fingerprint([
        'face_match',
        this.docPaths(documents, [DIDIT_SELFIE_DOC_TYPE, ...DIDIT_FACE_MATCH_REF_PRIORITY]),
        DIDIT_FACE_MATCH_DECLINE_THRESHOLD,
      ]),
      aml: this.fingerprint(['aml', who]),
      db: this.fingerprint(['database_validation', who]),
      liveness: this.fingerprint([
        'liveness',
        this.docPaths(documents, [DIDIT_SELFIE_DOC_TYPE]),
        DIDIT_LIVENESS_DECLINE_THRESHOLD,
      ]),
    };
  }

  private poaFingerprint(
    documents: Map<string, StoredDocument>,
    person: PersonLike | null,
  ): string {
    return this.fingerprint([
      'proof_of_address',
      this.docPaths(documents, [DIDIT_POA_DOC_TYPE]),
      person ? [this.normalize(person.first_name), this.normalize(person.last_name)] : null,
    ]);
  }

  private companyAmlFingerprint(business: Record<string, unknown>): string {
    return this.fingerprint([
      'company_aml',
      [
        business.legal_name,
        business.trade_name,
        business.tax_id,
        business.registration_number,
        business.country,
        business.country_of_incorporation,
        business.incorporation_date,
      ].map((v) => this.normalize(v)),
    ]);
  }

  /**
   * Una comprobación se reutiliza solo si salió 'Approved', con exactamente
   * las mismas entradas y dentro de la ventana de antigüedad. Lo que salió
   * Declined, In Review o falló se vuelve a correr siempre: es justo lo que
   * el staff quiere re-evaluar al forzar.
   */
  private canReuse(
    previous: (DiditCheckMeta & { status: DiditCheckStatus }) | null | undefined,
    fingerprint: string,
  ): boolean {
    if (!previous || previous.status !== 'Approved') return false;
    if (!previous.input_fingerprint || previous.input_fingerprint !== fingerprint) {
      return false;
    }
    const checkedAt = Date.parse(previous.checked_at ?? '');
    if (!Number.isFinite(checkedAt)) return false;
    return Date.now() - checkedAt <= DIDIT_REUSE_APPROVED_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  }

  /**
   * Devuelve el resultado anterior si es reutilizable; si no, llama a Didit.
   *
   * La promesa lleva un catch vacío adjunto: se lanzan varias en paralelo y
   * se esperan más tarde (tras otras lecturas de la DB), y una que rechace
   * antes de llegar al allSettled no debe contar como rechazo no manejado.
   * El rechazo sigue llegando intacto a quien la espera.
   */
  private reuseOr<Raw, R extends DiditCheckMeta & { status: DiditCheckStatus }>(
    previous: R | null | undefined,
    fingerprint: string,
    run: () => Promise<Raw | Skipped>,
  ): Promise<Outcome<Raw, R>> {
    const promise: Promise<Outcome<Raw, R>> = this.canReuse(previous, fingerprint)
      ? Promise.resolve({ reused: { ...(previous as R), reused: true } })
      : run();
    promise.catch(() => undefined);
    return promise;
  }

  private settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
    return Promise.allSettled([promise]).then(([result]) => result);
  }

  /** Lanza las 5 comprobaciones de una persona, reutilizando lo reutilizable. */
  private launchPersonChecks(
    documents: Map<string, StoredDocument>,
    person: PersonLike,
    vendorData: string,
    previous: PersonPrevious | null,
  ): PersonChecksLaunch {
    const fp = this.personFingerprints(documents, person);
    return {
      fingerprints: fp,
      id: this.reuseOr(previous?.id_verification, fp.id, () =>
        this.runIdVerification(documents, vendorData),
      ),
      face: this.reuseOr(previous?.face_match, fp.face, () =>
        this.runFaceMatch(documents, vendorData),
      ),
      aml: this.reuseOr(previous?.aml, fp.aml, () => this.runAml(person, vendorData)),
      db: this.reuseOr(previous?.database_validation, fp.db, () =>
        this.runDatabaseValidation(person, vendorData),
      ),
      liveness: this.reuseOr(previous?.liveness, fp.liveness, () =>
        this.runLiveness(documents, vendorData),
      ),
    };
  }

  private skippedPersonChecks(reason: string): PersonChecksLaunch {
    const skipped = Promise.resolve({ skipped: reason });
    return {
      fingerprints: null,
      id: skipped,
      face: skipped,
      aml: skipped,
      db: skipped,
      liveness: skipped,
    };
  }

  private async settlePersonChecks(launch: PersonChecksLaunch): Promise<PersonChecksSettled> {
    const [idResult, faceResult, amlResult, dbResult, livenessResult] = await Promise.allSettled([
      launch.id,
      launch.face,
      launch.aml,
      launch.db,
      launch.liveness,
    ]);
    return {
      fingerprints: launch.fingerprints,
      idResult,
      faceResult,
      amlResult,
      dbResult,
      livenessResult,
    };
  }

  /**
   * Misma persona registrada como representante y como UBO (caso habitual en
   * empresas pequeñas: el dueño es también el gerente). Se compara por número
   * de documento; sin documento en alguno de los dos, por nombre + apellido +
   * fecha de nacimiento completos. Ante la duda NO se deduplica: un falso
   * "misma persona" dejaría a un UBO sin verificar, un falso "distinta" solo
   * cuesta una verificación de más.
   */
  private isSamePerson(a: PersonLike, b: PersonLike): boolean {
    const doc = (p: PersonLike) => this.normalize(p.id_number).replace(/[\s.\-]/g, '');
    const docA = doc(a);
    const docB = doc(b);
    if (docA && docB) {
      if (docA !== docB) return false;
      const natA = this.normalize(a.nationality);
      const natB = this.normalize(b.nationality);
      return !natA || !natB || natA === natB;
    }

    const fields = (p: PersonLike) =>
      [p.first_name, p.last_name, p.date_of_birth].map((v) => this.normalize(v));
    const fa = fields(a);
    const fb = fields(b);
    return fa.every(Boolean) && fa.every((v, i) => v === fb[i]);
  }

  // ── Construcción de resultados compartida (KYC + KYB) ────────────────

  /**
   * Resuelve una comprobación: rechazo → error, reutilizada → tal cual,
   * omitida → Skipped, respuesta de Didit → mapeada y sellada con su huella
   * para poder reutilizarla en la próxima re-ejecución forzada.
   */
  private resolveCheck<Raw, R extends DiditCheckMeta & { status: DiditCheckStatus }>(
    settled: PromiseSettledResult<Outcome<Raw, R>>,
    checkName: string,
    errors: Array<{ check: string; message: string }>,
    fingerprint: string | undefined,
    onSkipped: (reason: string) => R,
    onRaw: (raw: Raw) => R,
  ): R | null {
    if (settled.status === 'rejected') {
      errors.push({ check: checkName, message: settled.reason?.message ?? 'Error desconocido' });
      return null;
    }

    const value = settled.value as object;
    if ('reused' in value) return (value as Reused<R>).reused;
    if ('skipped' in value) return onSkipped((value as Skipped).skipped);

    const mapped = onRaw(value as Raw);
    return fingerprint
      ? { ...mapped, input_fingerprint: fingerprint, checked_at: new Date().toISOString() }
      : mapped;
  }

  private mapWarnings(
    warnings: Array<{ code?: string; description?: string }> | undefined,
  ): DiditVerdictWarning[] {
    return (warnings ?? []).map((w) => ({ code: w.code, description: w.description }));
  }

  private mapAml(value: DiditAmlRaw): DiditAmlResult {
    const v = value.aml;
    return {
      status: v.status,
      request_id: value.request_id,
      score: v.score,
      total_hits: v.total_hits,
      hits_summary: (v.hits ?? []).map((h) => ({ name: h.name, type: h.type, source: h.source })),
      warnings: this.mapWarnings(v.warnings),
    };
  }

  /**
   * Mapea los 5 resultados de una persona (id_verification, face_match,
   * aml, database_validation, liveness) al formato del veredicto, con los
   * mismatches de id_verification contra los datos que Guira ya tiene.
   * Usado tanto para la persona de KYC como para el representante y cada
   * UBO de KYB.
   */
  private buildPersonResult(input: {
    checkPrefix: string;
    checks: PersonChecksSettled;
    referencePerson: PersonLike | null;
  }): PersonCheckBundle {
    const errors: Array<{ check: string; message: string }> = [];
    const prefix = input.checkPrefix;
    const ref = input.referencePerson;
    const fp = input.checks.fingerprints;

    const idVerification = this.resolveCheck<DiditIdVerificationRaw, DiditIdVerificationResult>(
      input.checks.idResult,
      `${prefix}id_verification`,
      errors,
      fp?.id,
      () => ({ status: 'Skipped', warnings: [], mismatches: [] }),
      (value) => {
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

        return {
          status: v.status,
          request_id: value.request_id,
          document_number_last4: v.document_number ? v.document_number.slice(-4) : undefined,
          first_name: v.first_name,
          last_name: v.last_name,
          date_of_birth: v.date_of_birth,
          nationality: v.nationality,
          warnings: this.mapWarnings(v.warnings),
          mismatches,
        };
      },
    );

    const faceMatch = this.resolveCheck<DiditFaceMatchRaw, DiditFaceMatchResult>(
      input.checks.faceResult,
      `${prefix}face_match`,
      errors,
      fp?.face,
      (reason) => ({ status: 'Skipped', warnings: [], skip_reason: reason }),
      (value) => ({
        status: value.face_match.status,
        request_id: value.request_id,
        score: value.face_match.score,
        warnings: this.mapWarnings(value.face_match.warnings),
      }),
    );

    const aml = this.resolveCheck<DiditAmlRaw, DiditAmlResult>(
      input.checks.amlResult,
      `${prefix}aml`,
      errors,
      fp?.aml,
      () => ({ status: 'Skipped', warnings: [], hits_summary: [] }),
      (value) => this.mapAml(value),
    );

    const databaseValidation = this.resolveCheck<
      DiditDatabaseValidationRaw,
      DiditDatabaseValidationResult
    >(
      input.checks.dbResult,
      `${prefix}database_validation`,
      errors,
      fp?.db,
      (reason) => ({ status: 'Skipped', warnings: [], skip_reason: reason }),
      (value) => ({
        status: value.database_validation.status,
        request_id: value.request_id,
        match_type: value.database_validation.match_type,
        warnings: [],
      }),
    );

    const liveness = this.resolveCheck<DiditLivenessRaw, DiditLivenessResult>(
      input.checks.livenessResult,
      `${prefix}liveness`,
      errors,
      fp?.liveness,
      (reason) => ({ status: 'Skipped', warnings: [], skip_reason: reason }),
      (value) => ({
        status: value.liveness.status,
        request_id: value.request_id,
        score: value.liveness.score,
        warnings: this.mapWarnings(value.liveness.warnings),
      }),
    );

    return {
      id_verification: idVerification,
      face_match: faceMatch,
      aml,
      database_validation: databaseValidation,
      liveness,
      errors,
    };
  }

  private mapPoaResult(
    result: PromiseSettledResult<PoaOutcome>,
    checkName: string,
    errors: Array<{ check: string; message: string }>,
    fingerprint: string,
  ): DiditPoaResult | null {
    return this.resolveCheck<DiditPoaRaw, DiditPoaResult>(
      result,
      checkName,
      errors,
      fingerprint,
      (reason) => ({ status: 'Skipped', warnings: [], skip_reason: reason }),
      (value) => ({
        status: value.poa.status,
        request_id: value.request_id,
        issuer: value.poa.issuer,
        warnings: this.mapWarnings(value.poa.warnings),
      }),
    );
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
    checks: PersonChecksSettled;
    poaResult: PromiseSettledResult<PoaOutcome>;
    poaFingerprint: string;
    person: PersonLike;
  }): DiditVerdict {
    const bundle = this.buildPersonResult({
      checkPrefix: '',
      checks: input.checks,
      referencePerson: input.person,
    });

    const errors = [...bundle.errors];
    const proofOfAddress = this.mapPoaResult(
      input.poaResult,
      'proof_of_address',
      errors,
      input.poaFingerprint,
    );

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

      // Resultados de la corrida anterior, por persona, para reutilizar en force.
      const previousPeople = existingDidit?.key_people ?? [];
      const previousFor = (role: 'director' | 'ubo', id: string): PersonPrevious | null =>
        previousPeople.find((p) => p.role === role && p.id === id) ?? null;

      const companyVendorData = `guira:kyb:${kybApplicationId}:company`;

      // 1. Empresa: AML + Proof of Address (el comprobante de domicilio del
      // negocio, subject_type='business' — sin subject_id porque solo hay
      // una empresa por solicitante).
      const companyAmlFingerprint = this.companyAmlFingerprint(business);
      const companyAmlPromise = this.reuseOr(existingDidit?.company_aml, companyAmlFingerprint, () =>
        this.runCompanyAml(business, companyVendorData),
      );
      const companyDocuments = await this.loadKybDocuments(kyb.requester_user_id, 'business');
      const companyPoaFingerprint = this.poaFingerprint(companyDocuments, null);
      const companyPoaPromise = this.reuseOr(
        existingDidit?.company_proof_of_address,
        companyPoaFingerprint,
        () => this.runProofOfAddress(companyDocuments, null, companyVendorData),
      );

      // 2. Representante legal: las 5 comprobaciones, igual que una persona
      // de KYC. Un negocio puede tener varios directores compartiendo
      // user_id — se acota a subject_type='director' + subject_id.
      const directors = (business.business_directors ?? []) as any[];
      const primaryDirector = directors.find((d: any) => d.is_signer) ?? directors[0] ?? null;

      const directorChecks = primaryDirector
        ? this.launchPersonChecks(
            await this.loadKybDocuments(kyb.requester_user_id, 'director', primaryDirector.id),
            primaryDirector,
            `guira:kyb:${kybApplicationId}:director:${primaryDirector.id}`,
            previousFor('director', primaryDirector.id),
          )
        : this.skippedPersonChecks('Sin representante legal registrado');

      // 3. Cada UBO: las mismas 5 comprobaciones que el representante. Si el
      // UBO es el propio representante, se reutilizan sus comprobaciones en
      // curso en lugar de pagarlas dos veces.
      const ubos = (business.business_ubos ?? []) as any[];
      const uboLaunches = await Promise.all(
        ubos.map(async (ubo) => {
          if (primaryDirector && this.isSamePerson(ubo, primaryDirector)) {
            return { ubo, checks: directorChecks, samePersonAs: primaryDirector.id as string };
          }
          const uboDocuments = await this.loadKybDocuments(kyb.requester_user_id, 'ubo', ubo.id);
          return {
            ubo,
            checks: this.launchPersonChecks(
              uboDocuments,
              ubo,
              `guira:kyb:${kybApplicationId}:ubo:${ubo.id}`,
              previousFor('ubo', ubo.id),
            ),
            samePersonAs: undefined,
          };
        }),
      );

      // Todo ya está corriendo en paralelo; aquí solo se espera.
      const [companyAmlResult, companyPoaResult] = await Promise.all([
        this.settle(companyAmlPromise),
        this.settle(companyPoaPromise),
      ]);
      const directorSettled = await this.settlePersonChecks(directorChecks);
      const ubosSettled = await Promise.all(
        uboLaunches.map(async (launch) => ({
          ubo: launch.ubo,
          samePersonAs: launch.samePersonAs,
          checks: await this.settlePersonChecks(launch.checks),
        })),
      );

      const verdict = this.buildKybVerdict({
        actorId,
        runCount: (existingDidit?.run_count ?? 0) + 1,
        companyAmlResult,
        companyAmlFingerprint,
        companyPoaResult,
        companyPoaFingerprint,
        director: directorSettled,
        ubos: ubosSettled,
        primaryDirector,
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
    companyAmlResult: PromiseSettledResult<AmlOutcome>;
    companyAmlFingerprint: string;
    companyPoaResult: PromiseSettledResult<PoaOutcome>;
    companyPoaFingerprint: string;
    director: PersonChecksSettled;
    ubos: Array<{ ubo: any; samePersonAs?: string; checks: PersonChecksSettled }>;
    primaryDirector: any | null;
  }): DiditVerdict {
    const errors: Array<{ check: string; message: string }> = [];

    // 1. Empresa: AML
    const companyAml = this.resolveCheck<DiditAmlRaw, DiditAmlResult>(
      input.companyAmlResult,
      'company_aml',
      errors,
      input.companyAmlFingerprint,
      () => ({ status: 'Skipped', warnings: [], hits_summary: [] }),
      (value) => this.mapAml(value),
    );

    // 2. Empresa: Proof of Address
    const companyPoa = this.mapPoaResult(
      input.companyPoaResult,
      'company_proof_of_address',
      errors,
      input.companyPoaFingerprint,
    );

    // 3. Representante legal — las 5 comprobaciones vía el builder compartido
    const directorBundle = this.buildPersonResult({
      checkPrefix: 'director_',
      checks: input.director,
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
    for (const { ubo, samePersonAs, checks } of input.ubos) {
      const bundle = this.buildPersonResult({
        checkPrefix: `ubo_${ubo.id}_`,
        checks,
        referencePerson: ubo,
      });
      // Un UBO deduplicado comparte las comprobaciones del representante: sus
      // errores ya están registrados con el prefijo director_.
      if (!samePersonAs) errors.push(...bundle.errors);
      uboBundles.push(bundle);

      keyPeople.push({
        id: ubo.id,
        role: 'ubo',
        name: [ubo.first_name, ubo.last_name].filter(Boolean).join(' ') || 'Beneficiario Final',
        position: ubo.position,
        percentage: typeof ubo.ownership_percent === 'number' ? ubo.ownership_percent : Number(ubo.ownership_percent) || undefined,
        same_person_as: samePersonAs,
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

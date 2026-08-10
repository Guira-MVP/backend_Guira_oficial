import { Injectable, Inject, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { ComplianceActionsService } from './compliance-actions.service';
import { PdfService } from '../../core/pdf/pdf.service';

interface GroupedDocument {
  storagePath: string;
  docTypeLabel: string;
  ownerLabel: string;
  folderName: string | null;
  extension: string;
}

/**
 * Exporta el expediente completo de onboarding (KYC/KYB) como un .zip —
 * resumen en PDF (en español) + todos los documentos adjuntos — para
 * envío manual a proveedores de onboarding que no tienen integración
 * automatizada (ej. Pythas, a diferencia de Bridge).
 *
 * Las etiquetas de documento y la agrupación por titular son un espejo de
 * DOCUMENT_LABELS / mergeDocuments / ownerLabelForSubject en
 * frontend_guira_staff/features/staff/components/onboarding-detail-page.tsx
 * — deben mantenerse sincronizadas manualmente (no hay paquete compartido
 * entre frontend y backend).
 */
@Injectable()
export class OnboardingExportService {
  private readonly logger = new Logger(OnboardingExportService.name);
  private static readonly STORAGE_BUCKET = 'kyc-documents';

  private static readonly DOCUMENT_LABELS: Record<string, string> = {
    id_front: 'Documento de identidad frente',
    id_back: 'Documento de identidad reverso',
    national_id_front: 'Cédula de identidad — anverso',
    national_id_back: 'Cédula de identidad — reverso',
    drivers_license_front: 'Licencia de conducir — anverso',
    drivers_license_back: 'Licencia de conducir — reverso',
    passport: 'Pasaporte',
    selfie: 'Selfie con documento',
    proof_of_address: 'Prueba de domicilio',
    utility_bill: 'Factura de servicios (prueba de domicilio)',
    bank_statement: 'Estado de cuenta bancario',
    legal_rep_id: 'Documento de representante legal',
    company_cert: 'Constitución o registro de empresa',
    incorporation_certificate: 'Certificado de constitución',
    business_formation: 'Documento de formación de la empresa',
    ownership_information: 'Información de titularidad / accionistas',
    operating_agreement: 'Acuerdo operativo / estatutos',
    proof_of_nature_of_business: 'Prueba de la naturaleza del negocio',
    source_of_funds: 'Origen de fondos',
    flow_of_funds: 'Flujo de fondos',
    tax_certificate: 'Certificado tributario',
    tax_registration: 'Registro tributario',
    other: 'Otro documento',
  };

  private static readonly KNOWN_PAYLOAD_KEYS = new Set([
    'id_front',
    'id_back',
    'selfie',
    'proof_of_address',
    'company_cert',
    'legal_rep_id',
    'passport',
  ]);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly actionsService: ComplianceActionsService,
    private readonly pdfService: PdfService,
  ) {}

  /** Export keyed by compliance_reviews.id — usado desde la pestaña "Revisión" del expediente. */
  async exportOnboardingZip(
    reviewId: string,
    actorId: string,
    actorRole: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const detail: any = await this.actionsService.getReviewDetail(reviewId);
    const observations =
      Array.isArray(detail.comments) && detail.comments.length > 0
        ? (detail.comments[0]?.body ?? null)
        : null;

    return this.buildZipFromDetail(detail, {
      actorId,
      actorRole,
      referenceId: reviewId,
      openedAt: detail.opened_at ?? null,
      closedAt: detail.closed_at ?? null,
      observations,
      auditTableName: 'compliance_reviews',
      auditRecordId: reviewId,
    });
  }

  /**
   * Export keyed por user_id — usado desde la pestaña "Onboarding" del
   * perfil de usuario. No depende de que exista un review abierto, por lo
   * que sigue funcionando después de que Bridge ya aprobó al cliente
   * (momento en el que se envía este paquete a Pythas).
   */
  async exportOnboardingZipByUserId(
    userId: string,
    actorId: string,
    actorRole: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const detail: any = await this.actionsService.getOnboardingByUserId(userId);

    return this.buildZipFromDetail(detail, {
      actorId,
      actorRole,
      referenceId: userId,
      openedAt: detail.created_at ?? null,
      closedAt: detail.updated_at ?? null,
      observations: null,
      auditTableName:
        detail.onboarding_type === 'company'
          ? 'kyb_applications'
          : 'kyc_applications',
      auditRecordId: detail.id ?? userId,
    });
  }

  private async buildZipFromDetail(
    detail: any,
    ctx: {
      actorId: string;
      actorRole: string;
      referenceId: string;
      openedAt: string | null;
      closedAt: string | null;
      observations: string | null;
      auditTableName: string;
      auditRecordId: string;
    },
  ): Promise<{ buffer: Buffer; filename: string }> {
    const onboardingType: 'personal' | 'company' =
      detail.onboarding_type === 'company' ? 'company' : 'personal';
    const applicationData: Record<string, any> = detail.application_data ?? {};
    const profile: any = detail.profile ?? null;

    const clientName = this.resolveClientName(
      onboardingType,
      applicationData,
      profile,
    );
    const safeClientName = this.sanitize(clientName);

    const groupedDocs = this.groupDocuments(
      onboardingType,
      detail.documents ?? [],
      applicationData,
    );

    const zip = new JSZip();
    const documentsFolder = zip.folder('Documentos') ?? zip;
    const missingDocuments: string[] = [];
    const documentsSummary: Array<{
      ownerLabel: string;
      docTypeLabel: string;
      included: boolean;
    }> = [];
    const folderCounters = new Map<string, number>();

    for (const doc of groupedDocs) {
      const buffer = await this.downloadDocumentBuffer(doc.storagePath);
      const target = doc.folderName
        ? (documentsFolder.folder(doc.folderName) ?? documentsFolder)
        : documentsFolder;

      const counterKey = doc.folderName ?? '__root__';
      const nextIndex = (folderCounters.get(counterKey) ?? 0) + 1;
      folderCounters.set(counterKey, nextIndex);
      const fileName = `${String(nextIndex).padStart(2, '0')}_${this.sanitize(doc.docTypeLabel)}${doc.extension}`;

      if (buffer) {
        target.file(fileName, buffer);
      } else {
        missingDocuments.push(
          `${doc.ownerLabel} — ${doc.docTypeLabel} (${doc.storagePath})`,
        );
      }

      documentsSummary.push({
        ownerLabel: doc.ownerLabel,
        docTypeLabel: doc.docTypeLabel,
        included: Boolean(buffer),
      });
    }

    const status = profile?.onboarding_status ?? detail.status ?? 'in_review';
    const generatedByLabel = `${ctx.actorRole} (${ctx.actorId.slice(0, 8)})`;

    const summaryBuffer = await this.pdfService.generateOnboardingSummaryPdf({
      reviewId: ctx.referenceId,
      onboardingType,
      status,
      openedAt: ctx.openedAt,
      closedAt: ctx.closedAt,
      observations: ctx.observations,
      bridgeCustomerId: profile?.bridge_customer_id ?? null,
      displayName: clientName,
      profileEmail: profile?.email ?? null,
      applicationData,
      documentsSummary,
      generatedByLabel,
    });

    zip.file(`Resumen_Onboarding_${safeClientName}.pdf`, summaryBuffer);

    if (missingDocuments.length > 0) {
      zip.file(
        '_LEEME_DOCUMENTOS_FALTANTES.txt',
        this.buildMissingDocsNote(missingDocuments),
      );
    }

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const { error: auditError } = await this.supabase
      .from('audit_logs')
      .insert({
        performed_by: ctx.actorId,
        role: ctx.actorRole,
        action: 'EXPORT_ONBOARDING_ZIP',
        table_name: ctx.auditTableName,
        record_id: ctx.auditRecordId,
        new_values: {
          onboarding_type: onboardingType,
          documents_included: documentsSummary.filter((d) => d.included).length,
          documents_missing: missingDocuments.length,
          purpose: 'manual_onboarding_pythas',
        },
        source: 'admin_panel',
      });
    if (auditError) {
      this.logger.warn(
        `No se pudo registrar audit log de EXPORT_ONBOARDING_ZIP: ${auditError.message}`,
      );
    }

    const typePrefix = onboardingType === 'company' ? 'KYB' : 'KYC';
    const filename = `${typePrefix}_${safeClientName}_${ctx.referenceId.slice(0, 8)}.zip`;

    return { buffer, filename };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private resolveClientName(
    onboardingType: 'personal' | 'company',
    data: Record<string, any>,
    profile: any,
  ): string {
    if (onboardingType === 'company') {
      return (
        this.readString(data.company_legal_name) ??
        this.readString(profile?.full_name) ??
        'Empresa sin nombre'
      );
    }
    const fullName = [
      this.readString(data.first_names),
      this.readString(data.last_names),
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    return (
      fullName || this.readString(profile?.full_name) || 'Usuario sin nombre'
    );
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : null;
  }

  private normalizeObj(value: unknown): Record<string, any> {
    return value && typeof value === 'object'
      ? (value as Record<string, any>)
      : {};
  }

  /** Quita acentos (vía descomposición NFD + filtro de marcas combinantes 0x0300–0x036F) y deja solo [a-zA-Z0-9_]. */
  private sanitize(text: string): string {
    const withoutDiacritics = Array.from(text.normalize('NFD'))
      .filter((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code < 0x0300 || code > 0x036f;
      })
      .join('');
    const cleaned = withoutDiacritics
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return cleaned || 'Sin_Nombre';
  }

  private extensionOf(storagePath: string): string {
    const match = storagePath.match(/\.[a-zA-Z0-9]+$/);
    return match ? match[0].toLowerCase() : '';
  }

  private documentLabel(docType: string): string {
    const normalized = docType.replace(/^ubo_\d+_/, '');
    return (
      OnboardingExportService.DOCUMENT_LABELS[normalized] ??
      normalized.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    );
  }

  private isStoragePathValue(value: string): boolean {
    if (OnboardingExportService.KNOWN_PAYLOAD_KEYS.has(value)) return false;
    return value.includes('/') && /\.(pdf|png|jpe?g|webp)$/i.test(value);
  }

  private ownerLabelForSubject(
    subjectType: string | null | undefined,
    subjectId: string | null | undefined,
    uboIndexBySubjectId: Map<string, number>,
  ): string {
    if (subjectType === 'director') return 'Representante legal';
    if (subjectType === 'business') return 'Empresa';
    if (subjectType === 'ubo') {
      const index = subjectId ? uboIndexBySubjectId.get(subjectId) : undefined;
      return index != null ? `UBO ${index + 1}` : 'UBO';
    }
    return 'Titular';
  }

  private folderNameForOwner(
    onboardingType: 'personal' | 'company',
    ownerLabel: string,
  ): string | null {
    if (onboardingType === 'personal') return null;
    if (ownerLabel === 'Empresa') return 'Empresa';
    if (ownerLabel === 'Representante legal') return 'Representante_Legal';
    if (ownerLabel.startsWith('UBO')) return this.sanitize(ownerLabel);
    return 'Otros';
  }

  /** Espejo de mergeDocuments() del frontend — tabla `documents` + rutas sueltas en el payload. */
  private groupDocuments(
    onboardingType: 'personal' | 'company',
    documents: any[],
    applicationData: Record<string, any>,
  ): GroupedDocument[] {
    const ubos = Array.isArray(applicationData.ubos)
      ? applicationData.ubos
      : [];
    const uboIndexBySubjectId = new Map<string, number>();
    ubos.forEach((ubo: any, index: number) => {
      const id = this.readString(this.normalizeObj(ubo).id);
      if (id) uboIndexBySubjectId.set(id, index);
    });

    const result: GroupedDocument[] = [];
    const seenPaths = new Set<string>();

    for (const doc of documents) {
      const storagePath = doc?.storage_path;
      if (
        typeof storagePath !== 'string' ||
        !storagePath ||
        seenPaths.has(storagePath)
      )
        continue;
      const ownerLabel = this.ownerLabelForSubject(
        doc.subject_type,
        doc.subject_id,
        uboIndexBySubjectId,
      );
      result.push({
        storagePath,
        docTypeLabel: this.documentLabel(doc.document_type ?? 'documento'),
        ownerLabel,
        folderName: this.folderNameForOwner(onboardingType, ownerLabel),
        extension: this.extensionOf(storagePath),
      });
      seenPaths.add(storagePath);
    }

    for (const [key, value] of Object.entries(applicationData)) {
      if (key === 'ubos') continue;
      if (
        typeof value === 'string' &&
        this.isStoragePathValue(value) &&
        !seenPaths.has(value)
      ) {
        const ownerLabel = onboardingType === 'company' ? 'Empresa' : 'Titular';
        result.push({
          storagePath: value,
          docTypeLabel: this.documentLabel(key),
          ownerLabel,
          folderName: this.folderNameForOwner(onboardingType, ownerLabel),
          extension: this.extensionOf(value),
        });
        seenPaths.add(value);
      }
    }

    ubos.forEach((ubo: any, index: number) => {
      const entry = this.normalizeObj(ubo);
      const ownerLabel = `UBO ${index + 1}`;
      for (const [uboKey, uboValue] of Object.entries(entry)) {
        if (
          typeof uboValue === 'string' &&
          this.isStoragePathValue(uboValue) &&
          !seenPaths.has(uboValue)
        ) {
          result.push({
            storagePath: uboValue,
            docTypeLabel: this.documentLabel(uboKey),
            ownerLabel,
            folderName: this.folderNameForOwner(onboardingType, ownerLabel),
            extension: this.extensionOf(uboValue),
          });
          seenPaths.add(uboValue);
        }
      }
    });

    return result;
  }

  private async downloadDocumentBuffer(
    storagePath: string,
  ): Promise<Buffer | null> {
    try {
      const { data, error } = await this.supabase.storage
        .from(OnboardingExportService.STORAGE_BUCKET)
        .download(storagePath);

      if (error || !data) {
        this.logger.warn(
          `Export ZIP: no se pudo descargar ${storagePath} — ${error?.message}`,
        );
        return null;
      }
      return Buffer.from(await data.arrayBuffer());
    } catch (err) {
      this.logger.warn(
        `Export ZIP: excepción descargando ${storagePath} — ${err}`,
      );
      return null;
    }
  }

  private buildMissingDocsNote(missing: string[]): string {
    return [
      'DOCUMENTOS NO DISPONIBLES',
      '==========================',
      '',
      'Los siguientes documentos no se pudieron descargar desde el almacenamiento',
      'y NO están incluidos en este paquete. Verifica el expediente en el panel',
      'de staff o contacta al cliente para volver a solicitarlos:',
      '',
      ...missing.map((m) => `- ${m}`),
    ].join('\n');
  }
}

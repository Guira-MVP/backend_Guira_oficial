import { Injectable, BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DIDIT_AML_PATH,
  DIDIT_DATABASE_VALIDATION_PATH,
  DIDIT_FACE_MATCH_PATH,
  DIDIT_ID_VERIFICATION_PATH,
  DIDIT_PASSIVE_LIVENESS_PATH,
  DIDIT_POA_PATH,
  DIDIT_TIMEOUT_MS,
} from './didit.constants';
import {
  DiditAmlRaw,
  DiditDatabaseValidationRaw,
  DiditFaceMatchRaw,
  DiditFile,
  DiditIdVerificationRaw,
  DiditLivenessRaw,
  DiditPoaRaw,
} from './didit.types';

/**
 * Cliente HTTP centralizado para las Standalone APIs de Didit (v3).
 * Espejo de BridgeApiClient, con dos diferencias: las llamadas de
 * verificación van en multipart/form-data (no JSON) y cada POST lleva
 * un timeout explícito — a diferencia de Bridge, cada llamada es
 * facturable y no debe reintentarse automáticamente.
 */
@Injectable()
export class DiditApiClient {
  private readonly logger = new Logger(DiditApiClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      config.get<string>('app.diditApiUrl') ?? 'https://verification.didit.me';
    this.apiKey = config.get<string>('app.diditApiKey') ?? '';
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Redacta PII de identidad antes de loguear un error de Didit. A
   * diferencia de Bridge (datos bancarios), aquí lo sensible son nombres,
   * fechas de nacimiento y números de documento que el proveedor puede
   * ecoar en mensajes de validación.
   */
  private redactSensitiveError(rawBody: string): string {
    const sensitiveKeys = [
      'document_number',
      'first_name',
      'last_name',
      'full_name',
      'date_of_birth',
      'portrait_image',
      'front_image',
      'back_image',
      'identification_number',
      'name_on_document',
      'expected_first_name',
      'expected_last_name',
    ];

    let redacted = rawBody;
    for (const key of sensitiveKeys) {
      const jsonPattern = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, 'gi');
      redacted = redacted.replace(jsonPattern, '$1"[REDACTED]"');
    }

    return redacted.length > 2000 ? `${redacted.slice(0, 2000)}...[truncated]` : redacted;
  }

  private ensureConfigured(): void {
    if (!this.apiKey) {
      this.logger.warn('DIDIT_API_KEY no configurada');
      throw new BadGatewayException('Didit API no configurada.');
    }
  }

  /**
   * Traduce un error de Didit a una excepción con mensaje accionable.
   *
   * El 403 por saldo insuficiente merece mensaje propio: las Standalone APIs
   * NO tienen capa gratuita, así que quedarse sin crédito es el fallo más
   * probable en operación. Con el mensaje genérico el staff reintentaría en
   * bucle sin entender que hay que recargar saldo.
   */
  private async raiseFor(res: Response, path: string): Promise<never> {
    const raw = await res.text();
    this.logger.error(
      `Didit POST ${path} failed [${res.status}]: ${this.redactSensitiveError(raw)}`,
    );

    if (res.status === 403 && /credit/i.test(raw)) {
      throw new BadGatewayException(
        'Didit rechazó la verificación por saldo insuficiente. Las Standalone APIs no tienen capa gratuita: recarga crédito en business.didit.me.',
      );
    }

    throw new BadGatewayException(
      'Error al procesar la verificación con Didit. Inténtalo de nuevo.',
    );
  }

  private async postMultipart<T>(
    path: string,
    fields: Record<string, string | number | boolean | undefined>,
    files: Record<string, DiditFile | undefined>,
  ): Promise<T> {
    this.ensureConfigured();

    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      form.append(key, String(value));
    }
    for (const [key, file] of Object.entries(files)) {
      if (!file) continue;
      form.append(
        key,
        new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
        file.filename,
      );
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey },
      body: form,
      signal: AbortSignal.timeout(DIDIT_TIMEOUT_MS),
    });

    if (!res.ok) await this.raiseFor(res, path);

    return res.json() as Promise<T>;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    this.ensureConfigured();

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DIDIT_TIMEOUT_MS),
    });

    if (!res.ok) await this.raiseFor(res, path);

    return res.json() as Promise<T>;
  }

  async verifyId(input: {
    frontImage: DiditFile;
    backImage?: DiditFile;
    vendorData: string;
  }): Promise<DiditIdVerificationRaw> {
    return this.postMultipart<DiditIdVerificationRaw>(
      DIDIT_ID_VERIFICATION_PATH,
      { vendor_data: input.vendorData },
      { front_image: input.frontImage, back_image: input.backImage },
    );
  }

  async matchFaces(input: {
    userImage: DiditFile;
    refImage: DiditFile;
    threshold: number;
    vendorData: string;
  }): Promise<DiditFaceMatchRaw> {
    return this.postMultipart<DiditFaceMatchRaw>(
      DIDIT_FACE_MATCH_PATH,
      {
        vendor_data: input.vendorData,
        face_match_score_decline_threshold: input.threshold,
      },
      { user_image: input.userImage, ref_image: input.refImage },
    );
  }

  async screenAml(input: {
    fullName: string;
    entityType?: 'person' | 'company';
    dateOfBirth?: string;
    nationality?: string;
    documentNumber?: string;
    vendorData: string;
  }): Promise<DiditAmlRaw> {
    return this.postJson<DiditAmlRaw>(DIDIT_AML_PATH, {
      full_name: input.fullName,
      entity_type: input.entityType ?? 'person',
      date_of_birth: input.dateOfBirth,
      nationality: input.nationality,
      document_number: input.documentNumber,
      vendor_data: input.vendorData,
    });
  }

  /** Confirma los datos de identidad contra el registro gubernamental del país (ej. SEGIP en Bolivia). */
  async verifyDatabase(input: {
    issuingState: string;
    serviceId: string;
    documentNumber?: string;
    dateOfBirth?: string;
    firstName?: string;
    lastName?: string;
    vendorData: string;
  }): Promise<DiditDatabaseValidationRaw> {
    return this.postJson<DiditDatabaseValidationRaw>(DIDIT_DATABASE_VALIDATION_PATH, {
      issuing_state: input.issuingState,
      services: [input.serviceId],
      document_number: input.documentNumber,
      date_of_birth: input.dateOfBirth,
      first_name: input.firstName,
      last_name: input.lastName,
      vendor_data: input.vendorData,
    });
  }

  /** Anti-spoofing sobre la selfie: detecta deepfake, máscara o foto-de-foto — Face Match solo no lo cubre. */
  async checkLiveness(input: {
    userImage: DiditFile;
    threshold: number;
    vendorData: string;
  }): Promise<DiditLivenessRaw> {
    return this.postMultipart<DiditLivenessRaw>(
      DIDIT_PASSIVE_LIVENESS_PATH,
      {
        vendor_data: input.vendorData,
        face_liveness_score_decline_threshold: input.threshold,
      },
      { user_image: input.userImage },
    );
  }

  async verifyProofOfAddress(input: {
    document: DiditFile;
    expectedFirstName?: string;
    expectedLastName?: string;
    vendorData: string;
  }): Promise<DiditPoaRaw> {
    return this.postMultipart<DiditPoaRaw>(
      DIDIT_POA_PATH,
      {
        vendor_data: input.vendorData,
        expected_first_name: input.expectedFirstName,
        expected_last_name: input.expectedLastName,
      },
      { document: input.document },
    );
  }
}

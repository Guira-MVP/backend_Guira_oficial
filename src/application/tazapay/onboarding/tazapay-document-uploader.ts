import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';
import { TazapayApiClient } from '../tazapay-api.client';
import { TazapayDocumentSpec } from './tazapay-document-map';

const STORAGE_BUCKET = 'kyc-documents';

export interface StoredDocument {
  id: string;
  document_type: string;
  document_subtype: string | null;
  storage_path: string;
  mime_type: string;
  file_name: string | null;
  subject_type: string;
  subject_id: string | null;
}

export interface TazapayDocumentRef {
  type: string;
  sub_type: string;
  tag: string;
  description: string;
  file_name: string;
  url: string;
}

/**
 * Sube un documento de Guira a Tazapay (lo usan el envío KYB y el KYC):
 *   1. POST /v3/metadata/doc/upload → nombre del archivo + URL presignada (1 h)
 *   2. PUT del archivo a esa URL
 *   3. registro en provider_submission_documents, para que un reintento no
 *      vuelva a subir lo que ya está en Tazapay.
 */
@Injectable()
export class TazapayDocumentUploader {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly api: TazapayApiClient,
  ) {}

  async uploadOne(
    submissionId: string,
    doc: StoredDocument,
    spec: TazapayDocumentSpec,
  ): Promise<TazapayDocumentRef> {
    const ref = (fileName: string, url: string): TazapayDocumentRef => ({
      type: spec.type,
      sub_type: spec.sub_type,
      tag: spec.tag,
      description: spec.description,
      file_name: fileName,
      url,
    });

    const { data: existing } = await this.supabase
      .from('provider_submission_documents')
      .select('provider_file_name, provider_url')
      .eq('submission_id', submissionId)
      .eq('document_id', doc.id)
      .eq('slot', spec.slot)
      .maybeSingle();
    if (existing?.provider_url && existing.provider_file_name) {
      return ref(
        existing.provider_file_name as string,
        existing.provider_url as string,
      );
    }

    const { data: file, error } = await this.supabase.storage
      .from(STORAGE_BUCKET)
      .download(doc.storage_path);
    if (error || !file)
      throw new Error(
        `No se pudo descargar el documento ${doc.id} de Storage.`,
      );
    const bytes = Buffer.from(await file.arrayBuffer());

    const extension =
      doc.mime_type === 'application/pdf'
        ? 'pdf'
        : doc.mime_type === 'image/png'
          ? 'png'
          : 'jpg';
    const requested = `${spec.slot.replace(/[^a-z0-9]+/gi, '_')}_${doc.id}.${extension}`;
    const presigned = await this.api.post<{
      data?: { url?: string; file_name?: string };
    }>('/v3/metadata/doc/upload', {
      file_name: requested,
    });
    const uploadUrl = presigned?.data?.url;
    const providerFileName = presigned?.data?.file_name ?? requested;
    if (!uploadUrl)
      throw new Error('Tazapay no devolvió la URL de subida del documento.');

    await this.api.uploadToPresignedUrl(uploadUrl, bytes, doc.mime_type);

    // documents[].url lleva la URL que devolvió Tazapay para el archivo
    // (validado en el sandbox el 2026-10-03: la entity se aprobó así).
    await this.supabase.from('provider_submission_documents').insert({
      submission_id: submissionId,
      document_id: doc.id,
      slot: spec.slot,
      provider_file_name: providerFileName,
      provider_url: uploadUrl,
    });
    return ref(providerFileName, uploadUrl);
  }
}

/** Copia del cuerpo enviado sin URLs, números de documento ni datos de contacto. */
export function redactedSnapshot(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(body, (key, value: unknown) => {
      if (
        [
          'url',
          'tax_id',
          'registration_number',
          'number',
          'email',
          'phone',
          'date_of_birth',
          'line1',
          'line2',
        ].includes(key)
      ) {
        return value === undefined ? undefined : '[REDACTED]';
      }
      return value;
    }),
  ) as Record<string, unknown>;
}

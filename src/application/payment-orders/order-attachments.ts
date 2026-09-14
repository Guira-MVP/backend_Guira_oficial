import { BadRequestException } from '@nestjs/common';

/**
 * order-attachments.ts
 *
 * Los tres documentos que cuelgan de un expediente y viven en Storage.
 *
 * Se nombran por su tipo (`deposit_proof`) y no por su columna
 * (`deposit_proof_url`) porque el tipo es lo que viaja en la URL del
 * endpoint. Mantener el mapeo aquí evita que el nombre de una columna de
 * base de datos quede expuesto en la API pública, y sobre todo evita que
 * alguien pueda pedir una columna arbitraria: solo estas tres claves
 * existen, cualquier otra cosa no resuelve.
 */

export const ATTACHMENT_COLUMNS = {
  /** PDF de respaldo que adjunta el cliente al crear la orden. */
  supporting_document: 'supporting_document_url',
  /** Comprobante del depósito que sube el cliente. */
  deposit_proof: 'deposit_proof_url',
  /** Documento CTAV que genera el equipo al completar la operación. */
  receipt: 'receipt_url',
} as const;

export type AttachmentKind = keyof typeof ATTACHMENT_COLUMNS;

export const ATTACHMENT_KINDS = Object.keys(ATTACHMENT_COLUMNS) as
  AttachmentKind[];

export function isAttachmentKind(value: string): value is AttachmentKind {
  return (ATTACHMENT_KINDS as string[]).includes(value);
}

/**
 * Único bucket del que se firman adjuntos de órdenes.
 *
 * Es una lista blanca a propósito: el backend firma con la service key, que
 * ignora la RLS, y el valor de la columna lo escribe el propio cliente.
 */
export const ATTACHMENT_BUCKET = 'payment-receipts';

/**
 * Vigencia del enlace firmado.
 *
 * Cinco minutos y no una hora —lo que usaba el frontend— porque ahora el
 * enlace se pide al pulsar «Descargar», no al pintar la pantalla: no hace
 * falta que sobreviva a una sesión entera con el expediente abierto.
 */
export const ATTACHMENT_URL_TTL_SECONDS = 5 * 60;

/**
 * Valida el valor guardado en la columna y devuelve la ruta dentro del
 * bucket de comprobantes.
 *
 * ⚠️ Esta función es la única defensa del endpoint de adjuntos. El backend
 * firma con la service key, que IGNORA la RLS, y `supporting_document_url`
 * lo escribe el propio cliente al crear la orden. Firmar a ciegas lo que
 * traiga la columna permitiría guardar
 * `kyc-documents/<otra-persona>/pasaporte.pdf` y leer documentación ajena.
 *
 * Acepta `payment-receipts/<uid>/archivo.pdf` —lo que guarda
 * `uploadFileToStorage` en el frontend— y también `<uid>/archivo.pdf`.
 * Rechaza cualquier otro bucket, las URL completas y los intentos de
 * salirse de la carpeta del dueño.
 */
export function resolveAttachmentPath(
  stored: string,
  ownerId: string,
): string {
  const value = stored.trim();

  // Una URL completa no debería estar nunca en estas columnas: si la hay,
  // es un dato viejo o manipulado y no hay nada que firmar.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    throw new BadRequestException('Documento con formato no soportado');
  }

  const segments = value.split('/').filter((part) => part !== '');

  // `..` escaparía de la carpeta del dueño aunque el primer segmento sea
  // el correcto.
  if (segments.some((part) => part === '.' || part === '..')) {
    throw new BadRequestException('Documento con ruta inválida');
  }

  const withoutBucket =
    segments[0] === ATTACHMENT_BUCKET ? segments.slice(1) : segments;

  // Hace falta carpeta Y archivo: un único segmento no identifica nada
  // dentro de la carpeta de nadie.
  if (withoutBucket.length < 2) {
    throw new BadRequestException('Documento con ruta inválida');
  }

  if (withoutBucket[0] !== ownerId) {
    throw new BadRequestException('Documento con ruta inválida');
  }

  return withoutBucket.join('/');
}

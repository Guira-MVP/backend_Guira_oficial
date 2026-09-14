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

/**
 * Catálogo de adjuntos.
 *
 * `allowsExternal` distingue quién escribe cada columna, y de ahí qué se
 * admite dentro:
 *
 *  · `supporting_document` y `deposit_proof` los escribe el CLIENTE
 *    (`updateOrderByUser` y el DTO de confirm-deposit). Solo pueden
 *    contener una ruta de Storage dentro de su propia carpeta. Si se
 *    admitiera una URL, un cliente podría guardar `https://phishing.site`
 *    y la aplicación se lo presentaría como enlace de descarga a quien
 *    consulte su cuenta —su contador, por ejemplo— con la credibilidad de
 *    venir de dentro del expediente.
 *
 *  · `receipt` lo escribe el EQUIPO al completar la operación, y en
 *    producción 38 de 48 filas son enlaces al dashboard de Bridge en vez
 *    de un archivo subido. Por eso admite URL, pero solo de los hosts de
 *    `ATTACHMENT_EXTERNAL_HOSTS`.
 */
const ATTACHMENT_CATALOG = {
  /** PDF de respaldo que adjunta el cliente al crear la orden. */
  supporting_document: { column: 'supporting_document_url', allowsExternal: false },
  /** Comprobante del depósito que sube el cliente. */
  deposit_proof: { column: 'deposit_proof_url', allowsExternal: false },
  /** Documento CTAV: archivo subido por el equipo, o enlace a Bridge. */
  receipt: { column: 'receipt_url', allowsExternal: true },
} as const;

export type AttachmentKind = keyof typeof ATTACHMENT_CATALOG;

export const ATTACHMENT_COLUMNS: Record<AttachmentKind, string> = {
  supporting_document: ATTACHMENT_CATALOG.supporting_document.column,
  deposit_proof: ATTACHMENT_CATALOG.deposit_proof.column,
  receipt: ATTACHMENT_CATALOG.receipt.column,
};

export const ATTACHMENT_KINDS = Object.keys(ATTACHMENT_CATALOG) as
  AttachmentKind[];

export function isAttachmentKind(value: string): value is AttachmentKind {
  return (ATTACHMENT_KINDS as string[]).includes(value);
}

/**
 * Hosts externos admitidos en `receipt_url`.
 *
 * Lista blanca por host exacto, nunca por sufijo: comprobar con
 * `endsWith('bridge.xyz')` dejaría pasar `bridge.xyz.evil.com`.
 */
export const ATTACHMENT_EXTERNAL_HOSTS: readonly string[] = [
  'dashboard.bridge.xyz',
];

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
 * Longitud máxima admitida. El valor real más largo en producción mide 117
 * caracteres; 512 deja margen de sobra y evita alimentar al resolvedor con
 * cadenas arbitrariamente grandes.
 */
const MAX_STORED_LENGTH = 512;

/**
 * Caracteres admitidos en una ruta de Storage.
 *
 * Lista blanca estricta a propósito. Deja fuera `%`, que es lo que importa:
 * `%2e%2e%2f` no contiene `..` como texto, así que sobreviviría a la
 * comprobación de segmentos y solo se convertiría en `../` más tarde, al
 * normalizar la URL del lado de Storage. Los 220 valores reales de
 * producción caben todos aquí (sin `%`, sin `\`, sin caracteres de control).
 */
const SAFE_PATH_CHARS = /^[A-Za-z0-9._/-]+$/;

/** Qué se ha resuelto: un archivo que hay que firmar, o un enlace externo. */
export type ResolvedAttachment =
  | { type: 'storage'; path: string }
  | { type: 'external'; url: string };

/**
 * Valida el valor guardado en la columna y decide cómo servirlo.
 *
 * ⚠️ Esta función es la única defensa del endpoint de adjuntos. El backend
 * firma con la service key, que IGNORA la RLS, y dos de las tres columnas
 * las escribe el propio cliente. Firmar a ciegas lo que traiga la columna
 * permitiría guardar `kyc-documents/<otra-persona>/pasaporte.pdf` y leer
 * documentación ajena.
 *
 * Acepta `payment-receipts/<uid>/archivo.pdf` —lo que guarda
 * `uploadFileToStorage` en el frontend— y también `<uid>/archivo.pdf`.
 * Rechaza cualquier otro bucket y los intentos de salirse de la carpeta
 * del dueño.
 */
export function resolveAttachmentTarget(
  stored: string,
  ownerId: string,
  kind: AttachmentKind,
): ResolvedAttachment {
  const value = stored.trim();

  if (value.length === 0 || value.length > MAX_STORED_LENGTH) {
    throw new BadRequestException('Documento con ruta inválida');
  }

  // ¿Es una URL? Se detecta antes de mirar la ruta porque el tratamiento es
  // completamente distinto. `//host/x` cuenta: el navegador lo resolvería
  // como URL absoluta heredando el esquema.
  const looksAbsolute =
    /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');

  if (looksAbsolute) {
    if (!ATTACHMENT_CATALOG[kind].allowsExternal) {
      throw new BadRequestException('Documento con formato no soportado');
    }
    return { type: 'external', url: assertAllowedExternalUrl(value) };
  }

  if (!SAFE_PATH_CHARS.test(value)) {
    throw new BadRequestException('Documento con ruta inválida');
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

  return { type: 'storage', path: withoutBucket.join('/') };
}

/**
 * Comprueba que una URL externa apunta a un host admitido y por HTTPS.
 *
 * Se usa `new URL()` y se compara `hostname`, no una búsqueda de texto:
 * `https://evil.com/?x=https://dashboard.bridge.xyz` contiene el host
 * permitido pero no apunta a él, y `https://dashboard.bridge.xyz@evil.com`
 * lo lleva en la parte de credenciales.
 */
function assertAllowedExternalUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('Documento con formato no soportado');
  }

  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('Documento con formato no soportado');
  }

  if (!ATTACHMENT_EXTERNAL_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new BadRequestException('Documento con formato no soportado');
  }

  return parsed.toString();
}

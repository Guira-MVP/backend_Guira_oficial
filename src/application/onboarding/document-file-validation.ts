/**
 * Validación de archivos de onboarding (KYC/KYB).
 *
 * El `mimetype` y el `originalname` que llegan en el multipart los decide el
 * navegador —o quien arme la petición—, así que no bastan:
 *   - el contenido real se comprueba por su firma (magic bytes), para que un
 *     HTML o un ejecutable renombrado a .pdf no termine en Storage;
 *   - la extensión del objeto se deriva del tipo validado y nunca del nombre
 *     original (que podía traer `../` y salirse de la carpeta del usuario).
 */

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Límites de multer para las rutas de subida. Sin esto multer bufferiza en
 * memoria archivos de cualquier tamaño antes de que el servicio pueda
 * rechazarlos (DoS por memoria).
 */
export const DOCUMENT_UPLOAD_LIMITS = {
  fileSize: MAX_DOCUMENT_BYTES,
  files: 1,
  fields: 10,
} as const;

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
};

export const ALLOWED_DOCUMENT_MIME_TYPES = Object.keys(EXTENSION_BY_MIME);

/** Extensión segura para el objeto en Storage, o null si el tipo no se admite. */
export function extensionForMime(mimetype: string): string | null {
  return EXTENSION_BY_MIME[mimetype] ?? null;
}

function startsWith(buffer: Buffer, signature: number[], offset = 0): boolean {
  if (buffer.length < offset + signature.length) return false;
  return signature.every((byte, i) => buffer[offset + i] === byte);
}

/** ¿El contenido del archivo corresponde al tipo declarado? */
export function contentMatchesMime(
  buffer: Buffer | undefined,
  mimetype: string,
): boolean {
  if (!buffer || buffer.length === 0) return false;
  switch (mimetype) {
    case 'application/pdf':
      // "%PDF-"
      return startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'image/jpeg':
    case 'image/jpg':
      return startsWith(buffer, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return startsWith(
        buffer,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
    default:
      return false;
  }
}

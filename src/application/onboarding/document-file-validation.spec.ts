import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  DOCUMENT_UPLOAD_LIMITS,
  MAX_DOCUMENT_BYTES,
  contentMatchesMime,
  extensionForMime,
} from './document-file-validation';

/**
 * Los archivos de KYC/KYB llegan con un mimetype y un nombre que decide el
 * navegador (o un atacante). Estas pruebas fijan que el contenido real manda
 * y que la extensión en Storage nunca sale del nombre original.
 */

const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // "MZ"

describe('contentMatchesMime', () => {
  it.each([
    ['application/pdf', PDF],
    ['image/jpeg', JPEG],
    ['image/jpg', JPEG],
    ['image/png', PNG],
  ])('acepta un %s real', (mime, buffer) => {
    expect(contentMatchesMime(buffer, mime)).toBe(true);
  });

  it.each([
    ['application/pdf', HTML],
    ['image/png', HTML],
    ['image/jpeg', EXE],
    ['application/pdf', PNG],
    ['image/png', JPEG],
  ])(
    'rechaza contenido que no corresponde al tipo declarado (%s)',
    (mime, buffer) => {
      expect(contentMatchesMime(buffer, mime)).toBe(false);
    },
  );

  it('rechaza archivos vacíos, truncados o sin buffer', () => {
    expect(contentMatchesMime(Buffer.alloc(0), 'application/pdf')).toBe(false);
    expect(contentMatchesMime(Buffer.from([0x89, 0x50]), 'image/png')).toBe(
      false,
    );
    expect(contentMatchesMime(undefined, 'image/png')).toBe(false);
  });

  it('rechaza tipos fuera de la lista aunque el contenido parezca válido', () => {
    expect(contentMatchesMime(PDF, 'text/html')).toBe(false);
    expect(contentMatchesMime(PNG, 'image/svg+xml')).toBe(false);
  });
});

describe('extensionForMime', () => {
  it('deriva la extensión del tipo validado', () => {
    expect(extensionForMime('application/pdf')).toBe('pdf');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/jpg')).toBe('jpg');
    expect(extensionForMime('image/png')).toBe('png');
  });

  it('no devuelve extensión para tipos no admitidos', () => {
    expect(extensionForMime('text/html')).toBeNull();
    expect(extensionForMime('../../x')).toBeNull();
  });

  it('la lista de tipos admitidos coincide con las extensiones conocidas', () => {
    for (const mime of ALLOWED_DOCUMENT_MIME_TYPES) {
      expect(extensionForMime(mime)).not.toBeNull();
    }
  });
});

describe('DOCUMENT_UPLOAD_LIMITS', () => {
  it('multer corta en 10 MB y un solo archivo (no bufferiza archivos gigantes)', () => {
    expect(DOCUMENT_UPLOAD_LIMITS.fileSize).toBe(MAX_DOCUMENT_BYTES);
    expect(MAX_DOCUMENT_BYTES).toBe(10 * 1024 * 1024);
    expect(DOCUMENT_UPLOAD_LIMITS.files).toBe(1);
  });
});

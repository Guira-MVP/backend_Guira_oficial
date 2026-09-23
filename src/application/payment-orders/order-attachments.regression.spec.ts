import { BadRequestException } from '@nestjs/common';
import { resolveAttachmentTarget } from './order-attachments';

/**
 * En main, los adjuntos se firmaban desde el navegador. En staging los
 * firma el backend y `resolveAttachmentTarget` rechaza todo lo que no
 * reconoce. Si rechazara un formato que ya existe en producción, esos
 * documentos dejarían de poder descargarse al promover staging.
 *
 * Los casos replican los formatos reales de producción (auditados el
 * 2026-09-23 sobre 265 valores): son exactamente los que generan
 * `uploadFileToStorage`, `uploadOrderEvidence` y el alta de CTAV del staff
 * en el frontend, más los enlaces al dashboard de Bridge en `receipt_url`.
 */

const OWNER = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ORDER = '9a8b7c6d-5e4f-4a3b-9c1d-0e9f8a7b6c5d';
const OTHER_USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Mismas plantillas de nombre que usa el frontend al subir. */
const frontendPaths = {
  uploadFileToStorage: (ext: string) =>
    `payment-receipts/${OWNER}/upload_1726000000000_ab12c.${ext}`,
  uploadOrderEvidence: (ext: string) =>
    `payment-receipts/${OWNER}/${ORDER}_1726000000000.${ext}`,
  staffReceipt: (ext: string) =>
    `payment-receipts/${OWNER}/${ORDER}_receipt_1726000000000.${ext}`,
};

describe('resolveAttachmentTarget — formatos que ya existen en producción', () => {
  it.each(['pdf', 'png', 'jpg', 'jpeg', 'PDF', 'JPG', 'webp'])(
    'supporting_document subido con uploadFileToStorage (.%s)',
    (ext) => {
      expect(
        resolveAttachmentTarget(frontendPaths.uploadFileToStorage(ext), OWNER, 'supporting_document'),
      ).toEqual({ type: 'storage', path: `${OWNER}/upload_1726000000000_ab12c.${ext}` });
    },
  );

  it('deposit_proof subido con uploadOrderEvidence', () => {
    expect(
      resolveAttachmentTarget(frontendPaths.uploadOrderEvidence('pdf'), OWNER, 'deposit_proof'),
    ).toEqual({ type: 'storage', path: `${OWNER}/${ORDER}_1726000000000.pdf` });
  });

  it('receipt (CTAV) subido por el staff', () => {
    expect(
      resolveAttachmentTarget(frontendPaths.staffReceipt('pdf'), OWNER, 'receipt'),
    ).toEqual({ type: 'storage', path: `${OWNER}/${ORDER}_receipt_1726000000000.pdf` });
  });

  it('receipt como enlace al dashboard de Bridge (39 de 49 casos en producción)', () => {
    const url = 'https://dashboard.bridge.xyz/transfers/abc-123';
    expect(resolveAttachmentTarget(url, OWNER, 'receipt')).toEqual({
      type: 'external',
      url,
    });
  });

  it('acepta la ruta sin el prefijo del bucket', () => {
    expect(
      resolveAttachmentTarget(`${OWNER}/upload_1.pdf`, OWNER, 'supporting_document'),
    ).toEqual({ type: 'storage', path: `${OWNER}/upload_1.pdf` });
  });

  it('tolera espacios alrededor del valor guardado', () => {
    expect(
      resolveAttachmentTarget(`  ${frontendPaths.uploadOrderEvidence('png')}  `, OWNER, 'deposit_proof'),
    ).toEqual({ type: 'storage', path: `${OWNER}/${ORDER}_1726000000000.png` });
  });

  it('un valor más largo que el máximo de producción (117 caracteres) sigue cabiendo', () => {
    const long = `payment-receipts/${OWNER}/${ORDER}_receipt_1726000000000_extra.pdf`;
    expect(long.length).toBeGreaterThan(117);
    expect(() => resolveAttachmentTarget(long, OWNER, 'receipt')).not.toThrow();
  });
});

describe('resolveAttachmentTarget — lo que debe seguir rechazando', () => {
  it.each([
    ['carpeta de otro usuario', `payment-receipts/${OTHER_USER}/upload_1.pdf`, 'supporting_document'],
    ['otro bucket', `kyc-documents/${OWNER}/pasaporte.pdf`, 'supporting_document'],
    ['salto de directorio', `payment-receipts/${OWNER}/../${OTHER_USER}/a.pdf`, 'deposit_proof'],
    ['traversal codificado', `payment-receipts/${OWNER}/%2e%2e/a.pdf`, 'deposit_proof'],
    ['URL en una columna del cliente', 'https://dashboard.bridge.xyz/x', 'supporting_document'],
    ['host parecido al permitido', 'https://dashboard.bridge.xyz.evil.com/x', 'receipt'],
    ['http sin TLS', 'http://dashboard.bridge.xyz/x', 'receipt'],
    ['solo la carpeta, sin archivo', `payment-receipts/${OWNER}`, 'receipt'],
  ] as const)('%s', (_label, value, kind) => {
    expect(() => resolveAttachmentTarget(value, OWNER, kind)).toThrow(BadRequestException);
  });
});

describe('resolveAttachmentTarget — caso límite conocido', () => {
  /**
   * El frontend toma la extensión con `file.name.split('.').pop()`. Si el
   * archivo NO tiene punto, la "extensión" es el nombre entero, y con
   * espacios o paréntesis la ruta queda fuera de la lista blanca: el archivo
   * se sube pero después no se puede descargar. No pasa con ningún valor
   * actual de producción; se deja fijado para que la corrección (sanear la
   * extensión al subir) tenga una prueba de referencia.
   */
  it('un archivo sin extensión y con espacios produce una ruta no descargable', () => {
    const fileName = 'Comprobante (1)';
    const ext = fileName.split('.').pop();
    const stored = `payment-receipts/${OWNER}/upload_1726000000000_ab12c.${ext}`;

    expect(() => resolveAttachmentTarget(stored, OWNER, 'supporting_document')).toThrow(
      BadRequestException,
    );
  });
});

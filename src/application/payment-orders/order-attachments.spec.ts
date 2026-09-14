import { BadRequestException } from '@nestjs/common';
import {
  ATTACHMENT_KINDS,
  isAttachmentKind,
  resolveAttachmentPath,
} from './order-attachments';

/**
 * Pruebas de la validación de rutas de adjuntos.
 *
 * Esto no es una utilidad más: es la única defensa del endpoint que firma
 * documentos de expedientes. Ese endpoint firma con la service key, que
 * ignora la RLS, y una de las columnas que lee (`supporting_document_url`)
 * la escribe el propio cliente al crear la orden. Si la validación se
 * ablanda, se puede leer documentación de otras personas.
 */

const OWNER = '919e74a8-988d-42a1-9d50-d116a6ea9032';
const OTHER = '11111111-2222-3333-4444-555555555555';

describe('resolveAttachmentPath — rutas admitidas', () => {
  it('acepta la ruta con bucket, que es lo que guarda el frontend', () => {
    expect(
      resolveAttachmentPath(`payment-receipts/${OWNER}/upload_123.pdf`, OWNER),
    ).toBe(`${OWNER}/upload_123.pdf`);
  });

  it('acepta la ruta sin bucket', () => {
    expect(resolveAttachmentPath(`${OWNER}/upload_123.pdf`, OWNER)).toBe(
      `${OWNER}/upload_123.pdf`,
    );
  });

  it('tolera espacios alrededor', () => {
    expect(resolveAttachmentPath(`  ${OWNER}/a.pdf  `, OWNER)).toBe(
      `${OWNER}/a.pdf`,
    );
  });

  it('conserva subcarpetas dentro de la del dueño', () => {
    expect(resolveAttachmentPath(`${OWNER}/2026/marzo/a.pdf`, OWNER)).toBe(
      `${OWNER}/2026/marzo/a.pdf`,
    );
  });
});

describe('resolveAttachmentPath — lo que tiene que rechazar', () => {
  function expectRejected(stored: string) {
    expect(() => resolveAttachmentPath(stored, OWNER)).toThrow(
      BadRequestException,
    );
  }

  it('rechaza la carpeta de otra persona', () => {
    // El caso que importa: el valor de la columna dice pertenecer a otro.
    expectRejected(`${OTHER}/upload_123.pdf`);
    expectRejected(`payment-receipts/${OTHER}/upload_123.pdf`);
  });

  it('rechaza otros buckets aunque la carpeta sea la del dueño', () => {
    // `kyc-documents` guarda pasaportes y cédulas. Con la service key se
    // firmarían igual de bien que un comprobante.
    expectRejected(`kyc-documents/${OWNER}/pasaporte.pdf`);
    expectRejected(`brand-assets/${OWNER}/logo.png`);
  });

  it('rechaza subir de carpeta con ..', () => {
    expectRejected(`${OWNER}/../${OTHER}/upload_123.pdf`);
    expectRejected(`payment-receipts/${OWNER}/../../kyc-documents/x.pdf`);
    expectRejected(`..`);
  });

  it('rechaza URL completas', () => {
    expectRejected('https://evil.example.com/a.pdf');
    expectRejected('http://gdqircfwoimgrtjpegvb.supabase.co/x.pdf');
    expectRejected(`//evil.example.com/${OWNER}/a.pdf`);
    expectRejected('data:application/pdf;base64,AAAA');
  });

  it('rechaza rutas sin archivo', () => {
    expectRejected(OWNER);
    expectRejected(`payment-receipts/${OWNER}`);
    expectRejected('');
    expectRejected('/');
  });

  it('no se deja engañar por un prefijo parecido al del dueño', () => {
    // Comparación exacta de segmento, no `startsWith`.
    expectRejected(`${OWNER}-copia/a.pdf`);
    expectRejected(`${OWNER.slice(0, 8)}/a.pdf`);
  });
});

describe('isAttachmentKind', () => {
  it('acepta los tres tipos del catálogo', () => {
    expect(ATTACHMENT_KINDS).toEqual([
      'supporting_document',
      'deposit_proof',
      'receipt',
    ]);
    ATTACHMENT_KINDS.forEach((kind) => {
      expect(isAttachmentKind(kind)).toBe(true);
    });
  });

  it('rechaza cualquier otra cosa', () => {
    // El tipo viaja en la URL y se usa para elegir una columna: si aquí
    // pasara texto libre, se podría pedir cualquier campo de la tabla.
    expect(isAttachmentKind('bank_details')).toBe(false);
    expect(isAttachmentKind('supporting_document_url')).toBe(false);
    expect(isAttachmentKind('*')).toBe(false);
    expect(isAttachmentKind('')).toBe(false);
  });
});

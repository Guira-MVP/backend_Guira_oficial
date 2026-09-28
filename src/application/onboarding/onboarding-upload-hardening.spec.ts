import { BadRequestException } from '@nestjs/common';
import { OnboardingService } from './onboarding.service';

/**
 * uploadDocument es el único punto de entrada de archivos de onboarding
 * (cliente, staff asistido y subida móvil). Lo que se fija aquí:
 *   - un archivo cuyo contenido no coincide con su mimetype no llega a Storage;
 *   - la ruta en Storage queda dentro de la carpeta del usuario aunque el
 *     nombre original traiga '../';
 *   - el nombre que se guarda para mostrar no lleva rutas;
 *   - uploaded_by solo se escribe cuando sube el staff.
 */

const USER = '11111111-1111-1111-1111-111111111111';
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

function file(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'ci.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: PNG.length,
    buffer: PNG,
    ...overrides,
  } as Express.Multer.File;
}

function setup() {
  const uploads: Array<{ path: string; contentType?: string }> = [];
  const inserts: Array<Record<string, unknown>> = [];

  const supabase = {
    storage: {
      from: () => ({
        upload: (
          path: string,
          _body: unknown,
          opts: { contentType?: string },
        ) => {
          uploads.push({ path, contentType: opts.contentType });
          return Promise.resolve({ data: { path }, error: null });
        },
        remove: () => Promise.resolve({ data: null, error: null }),
      }),
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        insert: (values: Record<string, unknown>) => {
          if (table === 'documents') inserts.push(values);
          return b;
        },
        select: () => b,
        eq: () => b,
        neq: () => b,
        is: () => b,
        single: () =>
          Promise.resolve({
            data: { id: 'doc-1', ...inserts.at(-1) },
            error: null,
          }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: [], error: null }),
      });
      return b;
    },
  };

  const draftService = { hardDeleteDocuments: jest.fn() };
  const service = new OnboardingService(
    supabase as never,
    {} as never,
    {} as never,
    {} as never,
    { get: () => '' } as never,
    draftService as never,
  );
  return { service, uploads, inserts };
}

describe('OnboardingService.uploadDocument — endurecimiento', () => {
  it('rechaza un HTML disfrazado de PNG sin tocar Storage', async () => {
    const { service, uploads } = setup();
    const html = Buffer.from('<script>alert(1)</script>');
    await expect(
      service.uploadDocument(
        USER,
        file({ buffer: html, size: html.length }),
        'national_id',
        'person',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploads).toHaveLength(0);
  });

  it('no permite salir de la carpeta del usuario con el nombre del archivo', async () => {
    const { service, uploads, inserts } = setup();
    await service.uploadDocument(
      USER,
      file({ originalname: 'x./../../otro-usuario/evil.html' }),
      'national_id',
      'person',
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path.startsWith(`${USER}/`)).toBe(true);
    expect(uploads[0].path).not.toContain('..');
    expect(uploads[0].path.endsWith('.png')).toBe(true);
    expect(uploads[0].contentType).toBe('image/png');
    expect(inserts[0].file_name).toBe('evil.html');
  });

  it('rechaza un subject_id que no es UUID', async () => {
    const { service, uploads } = setup();
    await expect(
      service.uploadDocument(
        USER,
        file(),
        'national_id',
        'director',
        "1' OR '1'='1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(uploads).toHaveLength(0);
  });

  it('registra uploaded_by solo cuando sube el staff', async () => {
    const client = setup();
    await client.service.uploadDocument(USER, file(), 'national_id', 'person');
    expect(client.inserts[0]).not.toHaveProperty('uploaded_by');

    const staff = setup();
    await staff.service.uploadDocument(
      USER,
      file(),
      'national_id',
      'person',
      undefined,
      undefined,
      'staff-1',
    );
    expect(staff.inserts[0]).toMatchObject({
      uploaded_by: 'staff-1',
      user_id: USER,
      is_draft: true,
    });
  });
});

import { BadRequestException } from '@nestjs/common';
import { StaffClientCompletionService } from './staff-client-completion.service';
import { TazapayKybOnboardingService } from '../onboarding/tazapay-kyb-onboarding.service';

type Row = Record<string, unknown>;

/** Supabase en memoria: lo justo para las consultas del servicio. */
function fakeSupabase(tables: Record<string, Row[]>, staff: Row | null = null) {
  let seq = 0;
  const from = (table: string) => {
    tables[table] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let payload: Row = {};
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const run = (): { data: unknown; error: unknown } => {
      if (op === 'insert') {
        const row = { id: `row-${++seq}`, ...payload };
        tables[table].push(row);
        return { data: [row], error: null };
      }
      if (op === 'update') {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, payload));
        return { data: hit, error: null };
      }
      return { data: rows(), error: null };
    };
    const first = () => {
      const r = run();
      return Promise.resolve({
        data: (r.data as Row[] | null)?.[0] ?? null,
        error: r.error,
      });
    };
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
      order: () => b,
      limit: () => b,
      insert: (p: Row) => ((op = 'insert'), (payload = p), b),
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      maybeSingle: first,
      single: first,
      then: (res: (v: unknown) => unknown) => res(run()),
    });
    return b;
  };
  return {
    from,
    rpc: () => Promise.resolve({ data: staff, error: null }),
  };
}

const USER = '11111111-1111-1111-1111-111111111111';
const actor = { id: 'staff-1', profile: { role: 'staff' } } as never;

function build(tables: Record<string, Row[]>, staff: Row | null = null) {
  const onboarding = {
    upsertPerson: jest.fn(),
    upsertBusiness: jest.fn(),
    addDirector: jest.fn().mockResolvedValue({ id: 'dir-new' }),
    upsertLegalRepresentative: jest.fn().mockResolvedValue({ id: 'rep' }),
    upsertUbo: jest.fn().mockResolvedValue({ id: 'ubo-new' }),
    removeDirector: jest.fn().mockResolvedValue({}),
    removeUbo: jest.fn().mockResolvedValue({}),
    uploadDocument: jest.fn(),
    listDocuments: jest.fn().mockResolvedValue([]),
    getDocumentSignedUrl: jest.fn().mockResolvedValue({ signed_url: 'u' }),
  };
  const tazapayKyb = {
    loadContext: jest.fn().mockResolvedValue({}),
    missingForTazapay: jest.fn().mockReturnValue(['falta kyb']),
  };
  const tazapayKyc = {
    loadContext: jest.fn().mockResolvedValue({}),
    missingForTazapay: jest.fn().mockReturnValue(['falta kyc']),
  };
  const service = new StaffClientCompletionService(
    fakeSupabase(tables, staff) as never,
    onboarding as never,
    tazapayKyb as never,
    tazapayKyc as never,
  );
  return { service, onboarding, tazapayKyb, tazapayKyc, tables };
}

const approvedProfile = {
  id: USER,
  onboarding_status: 'approved',
  is_active: true,
  is_frozen: false,
  account_type: 'company',
};

describe('StaffClientCompletionService', () => {
  it('solo trabaja con clientes ya aprobados', async () => {
    const { service } = build({
      profiles: [{ ...approvedProfile, onboarding_status: 'pending' }],
    });
    await expect(service.getContext(USER)).rejects.toThrow(BadRequestException);
  });

  it('rechaza cuentas del personal interno', async () => {
    const { service } = build({ profiles: [approvedProfile] }, { id: USER });
    await expect(service.getContext(USER)).rejects.toThrow(/personal interno/);
  });

  it('actualiza la persona sin pasar por upsertPerson ni tocar el perfil', async () => {
    const { service, onboarding, tables } = build({
      profiles: [approvedProfile],
      people: [{ id: 'p1', user_id: USER, first_name: 'Ana' }],
    });
    await service.savePerson(actor, USER, { nationality: 'BO' });

    expect(onboarding.upsertPerson).not.toHaveBeenCalled();
    expect(tables.people[0].nationality).toBe('BO');
    expect(tables.profiles[0].onboarding_status).toBe('approved');
  });

  it('crea la solicitud KYC como aprobada y de migración si no existía', async () => {
    const { service, tables } = build({
      profiles: [approvedProfile],
      people: [{ id: 'p1', user_id: USER }],
    });
    await service.savePerson(actor, USER, { nationality: 'BO' });

    expect(tables.kyc_applications).toHaveLength(1);
    expect(tables.kyc_applications[0]).toMatchObject({
      user_id: USER,
      person_id: 'p1',
      status: 'approved',
      provider: 'bridge',
      source: 'bridge_migration',
    });
  });

  it('exige el DTO completo al crear la persona desde cero', async () => {
    const { service, onboarding } = build({ profiles: [approvedProfile] });
    await expect(
      service.savePerson(actor, USER, { nationality: 'BO' }),
    ).rejects.toThrow(/Faltan datos obligatorios/);
    expect(onboarding.upsertPerson).not.toHaveBeenCalled();
  });

  it('guarda la empresa, registra el KYB migrado y audita solo los nombres de campos', async () => {
    const { service, tables } = build({
      profiles: [approvedProfile],
      businesses: [{ id: 'b1', user_id: USER, legal_name: 'Acme' }],
    });
    await service.saveBusiness(actor, USER, { registration_number: '12345' });

    expect(tables.businesses[0].registration_number).toBe('12345');
    expect(tables.kyb_applications[0]).toMatchObject({
      business_id: 'b1',
      requester_user_id: USER,
      status: 'approved',
      source: 'bridge_migration',
    });
    const log = tables.audit_logs[0];
    expect(log.action).toBe('STAFF_COMPLETE_BUSINESS');
    expect(JSON.stringify(log.new_values)).not.toContain('12345');
    expect(log.new_values).toMatchObject({
      changed_fields: ['registration_number'],
    });
  });

  it('no deja subir documentos a una persona ajena al cliente', async () => {
    const { service, onboarding } = build({
      profiles: [approvedProfile],
      people: [{ id: 'otra', user_id: 'otro-usuario' }],
    });
    await expect(
      service.uploadDocument(actor, USER, {} as never, {
        document_type: 'passport',
        subject_type: 'person',
        subject_id: 'otra',
      }),
    ).rejects.toThrow(/no pertenece/);
    expect(onboarding.uploadDocument).not.toHaveBeenCalled();
  });

  it('el documento subido por el staff queda definitivo', async () => {
    const tables: Record<string, Row[]> = {
      profiles: [approvedProfile],
      people: [{ id: 'p1', user_id: USER }],
      documents: [{ id: 'd1', is_draft: true }],
    };
    const { service, onboarding } = build(tables);
    onboarding.uploadDocument.mockResolvedValue({ id: 'd1' });
    await service.uploadDocument(actor, USER, {} as never, {
      document_type: 'passport',
      subject_type: 'person',
      subject_id: 'p1',
    });
    expect(tables.documents[0].is_draft).toBe(false);
  });
});

describe('StaffClientCompletionService · guardas y contexto', () => {
  it('rechaza cuentas inactivas o congeladas', async () => {
    for (const patch of [{ is_active: false }, { is_frozen: true }]) {
      const { service } = build({
        profiles: [{ ...approvedProfile, ...patch }],
      });
      await expect(service.getContext(USER)).rejects.toThrow(
        /inactiva o congelada/,
      );
    }
  });

  it('cliente inexistente → 404', async () => {
    const { service } = build({ profiles: [] });
    await expect(service.getContext(USER)).rejects.toThrow(/no encontrado/);
  });

  it('empresa: devuelve los faltantes del KYB y reutiliza la solicitud existente', async () => {
    const { service, tables, tazapayKyb } = build({
      profiles: [approvedProfile],
      businesses: [{ id: 'b1', user_id: USER }],
      business_directors: [{ id: 'd1', business_id: 'b1' }],
      kyb_applications: [
        { id: 'kyb-1', business_id: 'b1', status: 'approved' },
      ],
    });
    const ctx = await service.getContext(USER);

    expect(ctx.kind).toBe('company');
    expect(ctx.kyb_application_id).toBe('kyb-1');
    expect(ctx.directors).toHaveLength(1);
    expect(ctx.missing).toEqual(['falta kyb']);
    expect(tazapayKyb.loadContext).toHaveBeenCalledWith('kyb-1');
    // No se creó una segunda solicitud ni se tocó la existente.
    expect(tables.kyb_applications).toHaveLength(1);
    expect(tables.kyb_applications[0].status).toBe('approved');
  });

  it('persona sin datos personales: lo dice como faltante y no crea solicitud', async () => {
    const { service, tables } = build({
      profiles: [{ ...approvedProfile, account_type: 'personal' }],
    });
    const ctx = await service.getContext(USER);

    expect(ctx.kind).toBe('personal');
    expect(ctx.missing).toEqual(['Datos personales del cliente']);
    expect(tables.kyc_applications ?? []).toHaveLength(0);
  });

  it('persona con datos: faltantes del KYC', async () => {
    const { service, tazapayKyc } = build({
      profiles: [approvedProfile],
      people: [{ id: 'p1', user_id: USER }],
      kyc_applications: [{ id: 'kyc-1', user_id: USER, person_id: 'p1' }],
    });
    const ctx = await service.getContext(USER);

    expect(ctx.kind).toBe('personal');
    expect(ctx.kyc_application_id).toBe('kyc-1');
    expect(ctx.missing).toEqual(['falta kyc']);
    expect(tazapayKyc.loadContext).toHaveBeenCalledWith('kyc-1');
  });

  it('sin persona, empresa ni tipo de cuenta: pide definir el tipo', async () => {
    const { service } = build({
      profiles: [{ ...approvedProfile, account_type: null }],
    });
    expect((await service.getContext(USER)).missing).toEqual([
      'Tipo de cuenta (persona o empresa)',
    ]);
  });

  it('una solicitud KYC antigua sin persona se vincula a la persona guardada', async () => {
    const { service, tables } = build({
      profiles: [approvedProfile],
      people: [{ id: 'p1', user_id: USER }],
      kyc_applications: [{ id: 'kyc-1', user_id: USER, person_id: null }],
    });
    await service.savePerson(actor, USER, { city: 'La Paz' });

    expect(tables.kyc_applications).toHaveLength(1);
    expect(tables.kyc_applications[0].person_id).toBe('p1');
  });

  it('rechaza una fecha de nacimiento de menor de edad', async () => {
    const { service, tables } = build({
      profiles: [approvedProfile],
      people: [{ id: 'p1', user_id: USER, date_of_birth: '1990-01-01' }],
    });
    const year = new Date().getUTCFullYear() - 10;
    await expect(
      service.savePerson(actor, USER, { date_of_birth: `${year}-01-01` }),
    ).rejects.toThrow(/mayor de 18/);
    expect(tables.people[0].date_of_birth).toBe('1990-01-01');
  });
});

describe('StaffClientCompletionService · directores y UBOs', () => {
  const company = () => ({
    profiles: [approvedProfile],
    businesses: [{ id: 'b1', user_id: USER }],
    business_directors: [
      { id: 'd1', business_id: 'b1', first_name: 'Ana' },
      { id: 'd-ajeno', business_id: 'otra-empresa', first_name: 'Eva' },
    ],
    business_ubos: [
      { id: 'u1', business_id: 'b1' },
      { id: 'u-ajeno', business_id: 'otra-empresa' },
    ],
  });
  const director = { first_name: 'Luis', is_signer: false } as never;

  it('el representante legal se reconcilia; un director común se agrega', async () => {
    const { service, onboarding } = build(company());
    await service.addDirector(actor, USER, {
      ...(director as object),
      is_signer: true,
    } as never);
    await service.addDirector(actor, USER, director);

    expect(onboarding.upsertLegalRepresentative).toHaveBeenCalledTimes(1);
    expect(onboarding.addDirector).toHaveBeenCalledTimes(1);
  });

  it('edita un director de la empresa del cliente', async () => {
    const { service, tables } = build(company());
    await service.updateDirector(actor, USER, 'd1', { nationality: 'BOL' });
    expect(tables.business_directors[0].nationality).toBe('BOL');
  });

  it('no deja editar un director de otra empresa', async () => {
    const { service, tables } = build(company());
    await expect(
      service.updateDirector(actor, USER, 'd-ajeno', { nationality: 'BOL' }),
    ).rejects.toThrow(/no encontrado/);
    expect(tables.business_directors[1].nationality).toBeUndefined();
  });

  it('al editar un UBO descarta client_uid (no es columna)', async () => {
    const { service, tables } = build(company());
    await service.updateUbo(actor, USER, 'u1', {
      client_uid: '22222222-2222-2222-2222-222222222222',
      ownership_percent: 40,
    });
    expect(tables.business_ubos[0]).toMatchObject({ ownership_percent: 40 });
    expect(tables.business_ubos[0]).not.toHaveProperty('client_uid');
  });

  it('no deja editar un UBO de otra empresa', async () => {
    const { service } = build(company());
    await expect(
      service.updateUbo(actor, USER, 'u-ajeno', { ownership_percent: 40 }),
    ).rejects.toThrow(/no encontrado/);
  });

  it('cada cambio queda auditado con el staff como actor', async () => {
    const { service, tables } = build(company());
    await service.updateDirector(actor, USER, 'd1', { nationality: 'BOL' });
    await service.removeUbo(actor, USER, 'u1');

    expect(tables.audit_logs.map((l) => l.action)).toEqual([
      'STAFF_COMPLETE_DIRECTOR',
      'STAFF_COMPLETE_UBO',
    ]);
    expect(tables.audit_logs.every((l) => l.performed_by === 'staff-1')).toBe(
      true,
    );
  });

  it('sin empresa registrada no se puede editar un director', async () => {
    const { service } = build({ profiles: [approvedProfile] });
    await expect(
      service.updateDirector(actor, USER, 'd1', { nationality: 'BOL' }),
    ).rejects.toThrow(/no tiene empresa/);
  });
});

describe('StaffClientCompletionService · documentos', () => {
  const company = () => ({
    profiles: [approvedProfile],
    businesses: [{ id: 'b1', user_id: USER }],
    business_ubos: [{ id: 'u-ajeno', business_id: 'otra-empresa' }],
  });

  it('exige subject_id', async () => {
    const { service } = build(company());
    await expect(
      service.uploadDocument(actor, USER, {} as never, {
        document_type: 'business_registration',
        subject_type: 'business',
      }),
    ).rejects.toThrow(/subject_id es obligatorio/);
  });

  it('rechaza subject_type desconocido', async () => {
    const { service } = build(company());
    await expect(
      service.uploadDocument(actor, USER, {} as never, {
        document_type: 'x',
        subject_type: 'otro',
        subject_id: 'b1',
      }),
    ).rejects.toThrow(/subject_type inválido/);
  });

  it('no deja subir a nombre de otra empresa ni de su UBO', async () => {
    const { service, onboarding } = build(company());
    await expect(
      service.uploadDocument(actor, USER, {} as never, {
        document_type: 'business_registration',
        subject_type: 'business',
        subject_id: 'otra-empresa',
      }),
    ).rejects.toThrow(/no pertenece/);
    await expect(
      service.uploadDocument(actor, USER, {} as never, {
        document_type: 'passport',
        subject_type: 'ubo',
        subject_id: 'u-ajeno',
      }),
    ).rejects.toThrow(/no pertenece/);
    expect(onboarding.uploadDocument).not.toHaveBeenCalled();
  });

  it('sube a nombre de la empresa con el staff como autor', async () => {
    const tables: Record<string, Row[]> = {
      ...company(),
      documents: [{ id: 'd9', is_draft: true }],
    };
    const { service, onboarding } = build(tables);
    onboarding.uploadDocument.mockResolvedValue({ id: 'd9' });
    await service.uploadDocument(actor, USER, {} as never, {
      document_type: 'proof_of_address',
      subject_type: 'business',
      subject_id: 'b1',
      document_subtype: 'utility_bill',
    });
    expect(onboarding.uploadDocument).toHaveBeenCalledWith(
      USER,
      {},
      'proof_of_address',
      'business',
      'b1',
      undefined,
      'staff-1',
      'utility_bill',
    );
    expect(tables.documents[0].is_draft).toBe(false);
  });

  it('ver un documento queda auditado', async () => {
    const { service, tables } = build(company());
    await service.getDocumentSignedUrl(actor, USER, 'doc-1');
    expect(tables.audit_logs[0]).toMatchObject({
      action: 'STAFF_COMPLETE_DOC_VIEW',
      record_id: 'doc-1',
    });
  });
});

describe('TazapayKybOnboardingService.missingData', () => {
  const service = new TazapayKybOnboardingService(
    {} as never,
    {} as never,
    {} as never,
  );
  const business = {
    entity_type: 'llc',
    registration_number: '123',
    address1: 'Calle 1',
    city: 'La Paz',
    country: 'BOL',
  };

  it('un cliente migrado sin representantes no pasa la validación', () => {
    const missing = service.missingData({
      userId: USER,
      business,
      directors: [],
      ubos: [],
      documents: [],
    });
    expect(missing).toContain('Representante legal (director) de la empresa');
  });

  it('pide fecha de nacimiento y nacionalidad de cada representante', () => {
    const missing = service.missingData({
      userId: USER,
      business,
      directors: [{ id: 'd1', first_name: 'Ana', last_name: 'Paz' }],
      ubos: [],
      documents: [],
    });
    expect(missing).toEqual([
      'Fecha de nacimiento de Ana Paz (director)',
      'Nacionalidad de Ana Paz (director)',
    ]);
  });
});

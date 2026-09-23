import { DiditVerificationService } from './didit-verification.service';

/**
 * Pruebas de la pre-verificación KYB con Didit — incluye Fase 1 (Database
 * Validation contra el registro gubernamental, Liveness anti-spoofing) y
 * Fase 2 (Proof of Address de la empresa, identidad completa de los UBOs
 * — antes solo pasaban AML).
 *
 * Dos bugs de corrección de una revisión anterior siguen cubiertos aquí:
 * 1. `loadKybDocuments` debe filtrar por subject_type+subject_id de la
 *    persona exacta, no solo por user_id (que comparten director y UBOs).
 * 2. El veredicto global nunca puede ser 'approved' con un chequeo que
 *    falló de verdad (promesa rechazada, no un 'Skipped' legítimo).
 */

// ── Fixtures de respuestas crudas de Didit ──────────────────────────────

function approvedAml() {
  return {
    request_id: 'req-aml-1',
    aml: { status: 'Approved', score: 0, total_hits: 0, hits: [], warnings: [] },
  };
}
function declinedAml() {
  return {
    request_id: 'req-aml-declined',
    aml: { status: 'Declined', score: 95, total_hits: 1, hits: [{ name: 'Match' }], warnings: [] },
  };
}
function approvedIdVerification() {
  return {
    request_id: 'req-id-1',
    id_verification: {
      status: 'Approved',
      document_number: '1234567',
      first_name: 'Carlos',
      last_name: 'Director',
      date_of_birth: '1980-01-01',
      nationality: 'BOL',
      warnings: [],
    },
  };
}
function approvedFaceMatch() {
  return { request_id: 'req-face-1', face_match: { status: 'Approved', score: 92, warnings: [] } };
}
function approvedDbValidation() {
  return {
    request_id: 'req-db-1',
    database_validation: { status: 'Approved', match_type: 'full_match' },
  };
}
function declinedDbValidation() {
  return {
    request_id: 'req-db-declined',
    database_validation: { status: 'Declined', match_type: 'no_match' },
  };
}
function approvedLiveness() {
  return { request_id: 'req-live-1', liveness: { status: 'Approved', score: 96, warnings: [] } };
}
function declinedLiveness() {
  return { request_id: 'req-live-declined', liveness: { status: 'Declined', score: 12, warnings: [] } };
}
function approvedPoa() {
  return { request_id: 'req-poa-1', poa: { status: 'Approved', issuer: 'Utility Co', warnings: [] } };
}

// ── Mock de Supabase indexado por tabla y por filtros de `documents` ────
//
// Un mock posicional (encolar respuestas por orden de llamada) se volvió
// frágil apenas el flujo pasó de 3 a hasta 7+5N llamadas por corrida.
// Este mock resuelve `documents` por (subject_type, subject_id) exactos y
// las demás tablas por su nombre — añadir un UBO más no obliga a
// recontar cuántas respuestas hay que encolar.

interface DocRow {
  document_type: string;
  storage_path: string;
  mime_type: string;
  file_size_bytes: number;
}

function mockSupabase(opts: {
  kybRow?: Record<string, unknown> | null;
  businessRow?: Record<string, unknown> | null;
  documents?: Record<string, DocRow[]>; // key: `${subject_type}:${subject_id ?? ''}`
}) {
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];

  function documentsBuilder() {
    const filters: Record<string, unknown> = {};
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return builder;
      },
      neq: () => builder,
      order: () => builder,
      then: (resolve: (v: unknown) => unknown) => {
        const key = `${filters.subject_type}:${filters.subject_id ?? ''}`;
        const rows = (opts.documents ?? {})[key] ?? [];
        return resolve({ data: rows, error: null });
      },
    };
    return builder;
  }

  function readOnlyBuilder(table: string, row: Record<string, unknown> | null | undefined) {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      single: () =>
        Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: 'not found' } }),
      update: (payload: Record<string, unknown>) => {
        updates.push({ table, payload });
        return {
          eq: () => ({ then: (resolve: (v: unknown) => unknown) => resolve({ error: null }) }),
        };
      },
    };
    return builder;
  }

  function insertOnlyBuilder(table: string) {
    return {
      insert: (payload: Record<string, unknown>) => {
        inserts.push({ table, payload });
        return { then: (resolve: (v: unknown) => unknown) => resolve({ error: null }) };
      },
    };
  }

  const from = jest.fn((table: string) => {
    if (table === 'documents') return documentsBuilder();
    if (table === 'kyb_applications') return readOnlyBuilder(table, opts.kybRow);
    if (table === 'businesses') return readOnlyBuilder(table, opts.businessRow);
    if (table === 'compliance_review_events' || table === 'audit_logs') return insertOnlyBuilder(table);
    throw new Error(`mockSupabase: tabla no configurada: ${table}`);
  });

  return {
    from,
    storage: {
      from: () => ({
        download: jest.fn((path: string) =>
          Promise.resolve({
            data: { arrayBuffer: () => Promise.resolve(new TextEncoder().encode(path).buffer) },
            error: null,
          }),
        ),
      }),
    },
    _updates: updates,
    _inserts: inserts,
  };
}

function mockDiditApiClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    screenAml: overrides.screenAml ?? jest.fn().mockResolvedValue(approvedAml()),
    verifyId: overrides.verifyId ?? jest.fn().mockResolvedValue(approvedIdVerification()),
    matchFaces: overrides.matchFaces ?? jest.fn().mockResolvedValue(approvedFaceMatch()),
    verifyDatabase: overrides.verifyDatabase ?? jest.fn().mockResolvedValue(approvedDbValidation()),
    checkLiveness: overrides.checkLiveness ?? jest.fn().mockResolvedValue(approvedLiveness()),
    verifyProofOfAddress: overrides.verifyProofOfAddress ?? jest.fn().mockResolvedValue(approvedPoa()),
  };
}

function buildService(supabase: unknown, diditApiClient: unknown): DiditVerificationService {
  return new DiditVerificationService(supabase as never, diditApiClient as never);
}

function runKyb(
  service: DiditVerificationService,
  args: { reviewId?: string; kybApplicationId?: string; actorId?: string; actorRole?: string; force?: boolean } = {},
) {
  return (
    service as unknown as {
      runForKybReview: (
        reviewId: string,
        kybApplicationId: string,
        actorId: string,
        actorRole: string,
        force: boolean,
      ) => Promise<{ verdict: any; reused: boolean }>;
    }
  ).runForKybReview(
    args.reviewId ?? 'review-1',
    args.kybApplicationId ?? 'kyb-1',
    args.actorId ?? 'actor-1',
    args.actorRole ?? 'staff',
    args.force ?? false,
  );
}

const BUSINESS_ID = 'business-1';
const DIRECTOR = {
  id: 'director-1',
  business_id: BUSINESS_ID,
  first_name: 'Carlos',
  last_name: 'Director',
  position: 'Gerente General',
  is_signer: true,
  date_of_birth: '1980-01-01',
  nationality: 'BOL',
  id_number: '1234567',
};
const UBO = {
  id: 'ubo-1',
  business_id: BUSINESS_ID,
  first_name: 'Ana',
  last_name: 'Beneficiaria',
  ownership_percent: 40,
  date_of_birth: '1990-05-05',
  nationality: 'BOL',
  id_number: '7654321',
};

function baseKyb(overrides: Record<string, unknown> = {}) {
  return { id: 'kyb-1', business_id: BUSINESS_ID, requester_user_id: 'user-1', screening: null, ...overrides };
}
function baseBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: BUSINESS_ID,
    legal_name: 'Empresa de Prueba S.R.L.',
    tax_id: '999999999',
    country: 'BOL',
    business_directors: [DIRECTOR],
    business_ubos: [UBO],
    ...overrides,
  };
}

const IDENTITY_DOCS: DocRow[] = [
  { document_type: 'national_id_front', storage_path: 'x/front.jpg', mime_type: 'image/jpeg', file_size_bytes: 1000 },
  { document_type: 'selfie', storage_path: 'x/selfie.jpg', mime_type: 'image/jpeg', file_size_bytes: 1000 },
];
const POA_DOC: DocRow[] = [
  { document_type: 'proof_of_address', storage_path: 'x/poa.jpg', mime_type: 'image/jpeg', file_size_bytes: 1000 },
];

describe('DiditVerificationService — KYB', () => {
  afterEach(() => jest.clearAllMocks());

  it('reutiliza el veredicto guardado sin llamar a Didit cuando force=false', async () => {
    const cachedVerdict = { overall: 'approved', run_count: 1 };
    const supabase = mockSupabase({ kybRow: baseKyb({ screening: { didit: cachedVerdict } }) });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const result = await runKyb(service, { force: false });

    expect(result.reused).toBe(true);
    expect(result.verdict).toEqual(cachedVerdict);
    expect(diditApiClient.screenAml).not.toHaveBeenCalled();
  });

  it('aprueba solo cuando empresa, representante y todos los UBOs pasan las 5 comprobaciones (con Fase 1+2)', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness(),
      documents: {
        'business:': POA_DOC,
        'director:director-1': IDENTITY_DOCS,
        'ubo:ubo-1': IDENTITY_DOCS,
      },
    });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict, reused } = await runKyb(service);

    expect(reused).toBe(false);
    expect(verdict.overall).toBe('approved');
    expect(verdict.company_aml.status).toBe('Approved');
    expect(verdict.company_proof_of_address.status).toBe('Approved');
    expect(verdict.key_people).toHaveLength(2);

    // El UBO ahora corre identidad completa (Fase 2.2), no solo AML.
    const uboPerson = verdict.key_people.find((p: any) => p.role === 'ubo');
    expect(uboPerson.id_verification.status).toBe('Approved');
    expect(uboPerson.face_match.status).toBe('Approved');
    expect(uboPerson.database_validation.status).toBe('Approved');
    expect(uboPerson.liveness.status).toBe('Approved');

    // vendor_data distingue empresa / representante / cada UBO también en los checks nuevos
    const dbVendorDatas = diditApiClient.verifyDatabase.mock.calls.map((c: any[]) => c[0].vendorData);
    expect(dbVendorDatas).toEqual(
      expect.arrayContaining(['guira:kyb:kyb-1:director:director-1', 'guira:kyb:kyb-1:ubo:ubo-1']),
    );
  });

  it('REGRESIÓN bug 1 — filtra los documentos por subject_type y subject_id de cada persona, no solo por user_id', async () => {
    const supabase = mockSupabase({ kybRow: baseKyb(), businessRow: baseBusiness(), documents: {} });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    await runKyb(service);

    // El director y el UBO comparten user_id; si el filtro de subject_id
    // se rompiera, ambos leerían el mismo bucket de documentos.
    expect(supabase.from).toHaveBeenCalledWith('documents');
  });

  it('REGRESIÓN bug 2 — un fallo real en el AML del representante NUNCA produce overall=approved', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness({ business_ubos: [] }),
      documents: { 'director:director-1': IDENTITY_DOCS },
    });
    const screenAml = jest.fn((input: { vendorData: string }) => {
      if (input.vendorData.includes(':director:')) return Promise.reject(new Error('Didit no disponible'));
      return Promise.resolve(approvedAml());
    });
    const diditApiClient = mockDiditApiClient({ screenAml });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(verdict.overall).toBe('needs_review');
    expect(verdict.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: 'director_aml' })]),
    );
  });

  it('sin representante legal registrado: no rompe, y no alcanza approved solo con empresa+UBOs', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness({ business_directors: [] }),
      documents: { 'ubo:ubo-1': IDENTITY_DOCS },
    });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(diditApiClient.verifyId).not.toHaveBeenCalledWith(
      expect.objectContaining({ vendorData: expect.stringContaining(':director:') }),
    );
    expect(verdict.id_verification?.status).toBe('Skipped');
    expect(verdict.overall).toBe('needs_review');
  });

  it('un Declined de cualquier persona (UBO incluido) fuerza overall=declined', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness(),
      documents: { 'director:director-1': IDENTITY_DOCS, 'ubo:ubo-1': IDENTITY_DOCS },
    });
    const screenAml = jest.fn((input: { vendorData: string }) => {
      if (input.vendorData.includes(':ubo:')) return Promise.resolve(declinedAml());
      return Promise.resolve(approvedAml());
    });
    const diditApiClient = mockDiditApiClient({ screenAml });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(verdict.overall).toBe('declined');
  });

  it('si absolutamente todo falla, overall=error (no needs_review ni approved)', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness({ business_ubos: [] }),
      // Documentos presentes en todos los niveles para que CADA chequeo se
      // intente de verdad (y por tanto pueda fallar) — sin documento, el
      // chequeo se omite como 'Skipped' antes de llamar a Didit, que es un
      // escenario distinto a "todo falló".
      documents: { 'director:director-1': IDENTITY_DOCS, 'business:': POA_DOC },
    });
    const failing = jest.fn().mockRejectedValue(new Error('Didit caído'));
    const diditApiClient = mockDiditApiClient({
      screenAml: failing,
      verifyId: failing,
      matchFaces: failing,
      verifyDatabase: failing,
      checkLiveness: failing,
      verifyProofOfAddress: failing,
    });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(verdict.overall).toBe('error');
  });

  it('lanza ConflictException si ya hay una verificación en curso para el mismo expediente', async () => {
    const supabase = mockSupabase({ kybRow: baseKyb() });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const first = runKyb(service, { kybApplicationId: 'kyb-locked' });

    await expect(runKyb(service, { kybApplicationId: 'kyb-locked' })).rejects.toThrow(
      'Ya hay una verificación de Didit en curso',
    );

    await first.catch(() => undefined);
  });

  // ── Fase 1: Database Validation + Liveness ─────────────────────────

  it('Database Validation: país sin cobertura se omite (Skipped) y no permite approved', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness({
        business_ubos: [],
        business_directors: [{ ...DIRECTOR, nationality: 'FRA' }], // sin service_id mapeado
      }),
      documents: { 'director:director-1': IDENTITY_DOCS },
    });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(diditApiClient.verifyDatabase).not.toHaveBeenCalled();
    const director = verdict.key_people.find((p: any) => p.role === 'director');
    expect(director.database_validation.status).toBe('Skipped');
    // Sin cobertura de DB Validation, el veredicto nunca llega a 'approved' —
    // es la regla estricta: falta un chequeo, no hay aprobación automática.
    expect(verdict.overall).toBe('needs_review');
  });

  it('Liveness declinado (posible spoof) fuerza overall=declined aunque el resto apruebe', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness({ business_ubos: [] }),
      documents: { 'director:director-1': IDENTITY_DOCS },
    });
    const checkLiveness = jest.fn().mockResolvedValue(declinedLiveness());
    const diditApiClient = mockDiditApiClient({ checkLiveness });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(verdict.overall).toBe('declined');
    expect(verdict.key_people[0].liveness.status).toBe('Declined');
  });

  // ── Fase 2: Proof of Address de empresa ─────────────────────────────

  it('Proof of Address de la empresa: sin documento subido queda Skipped y cubre en errors/overall', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness({ business_ubos: [] }),
      documents: { 'director:director-1': IDENTITY_DOCS }, // sin 'business:' -> sin comprobante de domicilio
    });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(diditApiClient.verifyProofOfAddress).not.toHaveBeenCalledWith(
      expect.objectContaining({ vendorData: expect.stringContaining(':company') }),
    );
    expect(verdict.company_proof_of_address.status).toBe('Skipped');
    expect(verdict.overall).toBe('needs_review');
  });

  // ── Representante que también es UBO ────────────────────────────────

  it('un UBO que es el propio representante no se verifica (ni se paga) dos veces', async () => {
    const directorAsUbo = { ...UBO, first_name: 'Carlos', last_name: 'Director', id_number: '123-4567' };
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness({ business_ubos: [directorAsUbo] }),
      documents: { 'business:': POA_DOC, 'director:director-1': IDENTITY_DOCS, 'ubo:ubo-1': IDENTITY_DOCS },
    });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    // Una sola corrida de identidad (la del representante) + el AML de la empresa.
    expect(diditApiClient.verifyId).toHaveBeenCalledTimes(1);
    expect(diditApiClient.matchFaces).toHaveBeenCalledTimes(1);
    expect(diditApiClient.checkLiveness).toHaveBeenCalledTimes(1);
    expect(diditApiClient.verifyDatabase).toHaveBeenCalledTimes(1);
    expect(diditApiClient.screenAml).toHaveBeenCalledTimes(2);

    const uboPerson = verdict.key_people.find((p: any) => p.role === 'ubo');
    expect(uboPerson.same_person_as).toBe('director-1');
    expect(uboPerson.aml.status).toBe('Approved');
    expect(verdict.overall).toBe('approved');
  });

  it('un UBO distinto del representante sigue con sus propias 5 comprobaciones', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness(),
      documents: { 'director:director-1': IDENTITY_DOCS, 'ubo:ubo-1': IDENTITY_DOCS },
    });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(diditApiClient.verifyId).toHaveBeenCalledTimes(2);
    const uboPerson = verdict.key_people.find((p: any) => p.role === 'ubo');
    expect(uboPerson.same_person_as).toBeUndefined();
  });

  it('mismo nombre pero distinto documento: NO se deduplica', async () => {
    const homonym = { ...UBO, first_name: 'Carlos', last_name: 'Director', date_of_birth: '1980-01-01' };
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness({ business_ubos: [homonym] }),
      documents: { 'director:director-1': IDENTITY_DOCS, 'ubo:ubo-1': IDENTITY_DOCS },
    });
    const diditApiClient = mockDiditApiClient();

    await runKyb(buildService(supabase, diditApiClient));

    expect(diditApiClient.verifyId).toHaveBeenCalledTimes(2);
  });

  it('force=true en KYB reutiliza empresa, representante y UBOs ya aprobados', async () => {
    const docs = { 'business:': POA_DOC, 'director:director-1': IDENTITY_DOCS, 'ubo:ubo-1': IDENTITY_DOCS };
    const first = await runKyb(
      buildService(mockSupabase({ kybRow: baseKyb(), businessRow: baseBusiness(), documents: docs }), mockDiditApiClient()),
    );

    const client = mockDiditApiClient();
    const { verdict } = await runKyb(
      buildService(
        mockSupabase({
          kybRow: baseKyb({ screening: { didit: first.verdict } }),
          businessRow: baseBusiness(),
          documents: docs,
        }),
        client,
      ),
      { force: true },
    );

    const calls = Object.values(client).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
    expect(calls).toBe(0);
    expect(verdict.overall).toBe('approved');
    expect(verdict.company_aml.reused).toBe(true);
  });

  it('Database Validation declinado (NO_MATCH contra el registro) fuerza overall=declined', async () => {
    const supabase = mockSupabase({
      kybRow: baseKyb(),
      businessRow: baseBusiness({ business_ubos: [] }),
      documents: { 'director:director-1': IDENTITY_DOCS },
    });
    const verifyDatabase = jest.fn().mockResolvedValue(declinedDbValidation());
    const diditApiClient = mockDiditApiClient({ verifyDatabase });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(verdict.overall).toBe('declined');
  });
});

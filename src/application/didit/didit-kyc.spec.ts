import { DiditVerificationService } from './didit-verification.service';

/**
 * Pruebas de la pre-verificación KYC con Didit tras la Fase 1 (Database
 * Validation contra el registro gubernamental, Liveness anti-spoofing) y
 * Fase 2 (Proof of Address). El path de KYC ahora comparte `buildPersonResult`
 * con KYB — estas pruebas confirman que la regla estricta de `overall`
 * (ver didit-kyb.spec.ts) sigue aplicando igual de bien a una persona sola.
 */

function approvedAml() {
  return { request_id: 'req-aml-1', aml: { status: 'Approved', score: 0, total_hits: 0, hits: [], warnings: [] } };
}
function approvedIdVerification() {
  return {
    request_id: 'req-id-1',
    id_verification: {
      status: 'Approved',
      document_number: '10060025',
      first_name: 'Miguel',
      last_name: 'Tambo',
      date_of_birth: '1998-02-01',
      nationality: 'BOL',
      warnings: [],
    },
  };
}
function approvedFaceMatch() {
  return { request_id: 'req-face-1', face_match: { status: 'Approved', score: 92, warnings: [] } };
}
function approvedDbValidation() {
  return { request_id: 'req-db-1', database_validation: { status: 'Approved', match_type: 'full_match' } };
}
function declinedDbValidation() {
  return { request_id: 'req-db-declined', database_validation: { status: 'Declined', match_type: 'no_match' } };
}
function approvedLiveness() {
  return { request_id: 'req-live-1', liveness: { status: 'Approved', score: 96, warnings: [] } };
}
function declinedLiveness() {
  return { request_id: 'req-live-declined', liveness: { status: 'Declined', score: 10, warnings: [] } };
}
function approvedPoa() {
  return { request_id: 'req-poa-1', poa: { status: 'Approved', issuer: 'Utility Co', warnings: [] } };
}

interface DocRow {
  document_type: string;
  storage_path: string;
  mime_type: string;
  file_size_bytes: number;
}

function mockSupabase(opts: {
  kycRow?: Record<string, unknown> | null;
  personRow?: Record<string, unknown> | null;
  documents?: DocRow[];
}) {
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];

  function documentsBuilder() {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      order: () => builder,
      then: (resolve: (v: unknown) => unknown) => resolve({ data: opts.documents ?? [], error: null }),
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
        return { eq: () => ({ then: (resolve: (v: unknown) => unknown) => resolve({ error: null }) }) };
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
    if (table === 'kyc_applications') return readOnlyBuilder(table, opts.kycRow);
    if (table === 'people') return readOnlyBuilder(table, opts.personRow);
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

function runKyc(
  service: DiditVerificationService,
  args: { reviewId?: string; kycApplicationId?: string; actorId?: string; actorRole?: string; force?: boolean } = {},
) {
  return (
    service as unknown as {
      runForKycReview: (
        reviewId: string,
        kycApplicationId: string,
        actorId: string,
        actorRole: string,
        force: boolean,
      ) => Promise<{ verdict: any; reused: boolean }>;
    }
  ).runForKycReview(
    args.reviewId ?? 'review-1',
    args.kycApplicationId ?? 'kyc-1',
    args.actorId ?? 'actor-1',
    args.actorRole ?? 'staff',
    args.force ?? false,
  );
}

function baseKyc(overrides: Record<string, unknown> = {}) {
  return { id: 'kyc-1', user_id: 'user-1', person_id: 'person-1', screening: null, ...overrides };
}
function basePerson(overrides: Record<string, unknown> = {}) {
  return {
    first_name: 'Miguel',
    middle_name: 'Angel',
    last_name: 'Tambo',
    date_of_birth: '1998-02-01',
    nationality: 'BOL',
    id_number: '10060025',
    ...overrides,
  };
}

const ALL_DOCS: DocRow[] = [
  { document_type: 'national_id_front', storage_path: 'p/front.jpg', mime_type: 'image/jpeg', file_size_bytes: 1000 },
  { document_type: 'national_id_back', storage_path: 'p/back.jpg', mime_type: 'image/jpeg', file_size_bytes: 1000 },
  { document_type: 'selfie', storage_path: 'p/selfie.jpg', mime_type: 'image/jpeg', file_size_bytes: 1000 },
  { document_type: 'proof_of_address', storage_path: 'p/poa.jpg', mime_type: 'image/jpeg', file_size_bytes: 1000 },
];

describe('DiditVerificationService — KYC', () => {
  afterEach(() => jest.clearAllMocks());

  it('reutiliza el veredicto guardado sin llamar a Didit cuando force=false', async () => {
    const cachedVerdict = { overall: 'approved', run_count: 1 };
    const supabase = mockSupabase({ kycRow: baseKyc({ screening: { didit: cachedVerdict } }) });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const result = await runKyc(service, { force: false });

    expect(result.reused).toBe(true);
    expect(diditApiClient.screenAml).not.toHaveBeenCalled();
  });

  it('aprueba solo cuando las 6 comprobaciones pasan (ID, Face, AML, Database Validation, Liveness, POA)', async () => {
    const supabase = mockSupabase({ kycRow: baseKyc(), personRow: basePerson(), documents: ALL_DOCS });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict, reused } = await runKyc(service);

    expect(reused).toBe(false);
    expect(verdict.overall).toBe('approved');
    expect(verdict.id_verification.status).toBe('Approved');
    expect(verdict.face_match.status).toBe('Approved');
    expect(verdict.aml.status).toBe('Approved');
    expect(verdict.database_validation.status).toBe('Approved');
    expect(verdict.liveness.status).toBe('Approved');
    expect(verdict.proof_of_address.status).toBe('Approved');
  });

  it('un fallo real en AML (no Skipped) nunca produce overall=approved', async () => {
    const supabase = mockSupabase({ kycRow: baseKyc(), personRow: basePerson(), documents: ALL_DOCS });
    const screenAml = jest.fn().mockRejectedValue(new Error('Didit no disponible'));
    const diditApiClient = mockDiditApiClient({ screenAml });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyc(service);

    expect(verdict.overall).toBe('needs_review');
    expect(verdict.aml).toBeNull();
    expect(verdict.errors).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'aml' })]));
  });

  it('Liveness declinado fuerza overall=declined aunque el resto apruebe', async () => {
    const supabase = mockSupabase({ kycRow: baseKyc(), personRow: basePerson(), documents: ALL_DOCS });
    const checkLiveness = jest.fn().mockResolvedValue(declinedLiveness());
    const diditApiClient = mockDiditApiClient({ checkLiveness });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyc(service);

    expect(verdict.overall).toBe('declined');
    expect(verdict.liveness.status).toBe('Declined');
  });

  it('Database Validation declinado (NO_MATCH contra SEGIP) fuerza overall=declined', async () => {
    const supabase = mockSupabase({ kycRow: baseKyc(), personRow: basePerson(), documents: ALL_DOCS });
    const verifyDatabase = jest.fn().mockResolvedValue(declinedDbValidation());
    const diditApiClient = mockDiditApiClient({ verifyDatabase });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyc(service);

    expect(verdict.overall).toBe('declined');
  });

  it('sin cobertura de Database Validation para el país: Skipped, nunca approved', async () => {
    const supabase = mockSupabase({
      kycRow: baseKyc(),
      personRow: basePerson({ nationality: 'FRA' }),
      documents: ALL_DOCS,
    });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyc(service);

    expect(diditApiClient.verifyDatabase).not.toHaveBeenCalled();
    expect(verdict.database_validation.status).toBe('Skipped');
    expect(verdict.overall).toBe('needs_review');
  });

  it('sin comprobante de domicilio: Proof of Address queda Skipped y cubre en overall', async () => {
    const docsWithoutPoa = ALL_DOCS.filter((d) => d.document_type !== 'proof_of_address');
    const supabase = mockSupabase({ kycRow: baseKyc(), personRow: basePerson(), documents: docsWithoutPoa });
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyc(service);

    expect(diditApiClient.verifyProofOfAddress).not.toHaveBeenCalled();
    expect(verdict.proof_of_address.status).toBe('Skipped');
    expect(verdict.overall).toBe('needs_review');
  });

  it('detecta mismatches entre lo que extrae Didit y los datos de people', async () => {
    const supabase = mockSupabase({ kycRow: baseKyc(), personRow: basePerson(), documents: ALL_DOCS });
    const verifyId = jest.fn().mockResolvedValue({
      request_id: 'req-id-mismatch',
      id_verification: {
        status: 'Approved',
        document_number: '99999999',
        first_name: 'Otro',
        last_name: 'Nombre',
        date_of_birth: '1990-01-01',
        nationality: 'BOL',
        warnings: [],
      },
    });
    const diditApiClient = mockDiditApiClient({ verifyId });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyc(service);

    expect(verdict.id_verification.mismatches).toEqual(
      expect.arrayContaining(['first_name', 'last_name', 'date_of_birth', 'document_number']),
    );
  });

  it('si absolutamente todo falla, overall=error', async () => {
    const supabase = mockSupabase({ kycRow: baseKyc(), personRow: basePerson(), documents: ALL_DOCS });
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

    const { verdict } = await runKyc(service);

    expect(verdict.overall).toBe('error');
  });
});

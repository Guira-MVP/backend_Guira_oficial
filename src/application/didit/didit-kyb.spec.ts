import { DiditVerificationService } from './didit-verification.service';

/**
 * Pruebas de la pre-verificación KYB con Didit.
 *
 * Dos bugs de corrección encontrados y corregidos en la misma revisión que
 * agrega estas pruebas — ambos con su regresión aquí:
 *
 * 1. `loadKybDocuments` filtraba solo por `user_id`, mezclando los
 *    documentos de todos los directores/UBOs de un negocio (comparten
 *    `user_id`, se distinguen por `subject_type`+`subject_id`). Con más de
 *    una persona compartiendo `document_type` (ej. dos `national_id_front`),
 *    el representante legal terminaba verificado contra el documento de
 *    identidad de OTRA persona.
 * 2. El veredicto global (`overall`) trataba un chequeo en `null` (la
 *    promesa realmente rechazada — red, timeout, sin crédito) igual que
 *    "no aplica", así que un fallo real de Didit en el AML del
 *    representante o de un UBO podía colarse como `overall: 'approved'`.
 */

// ── Fixtures de respuestas crudas de Didit ──────────────────────────────

function approvedAml(overrides: Record<string, unknown> = {}) {
  return {
    request_id: 'req-aml-1',
    aml: { status: 'Approved', score: 0, total_hits: 0, hits: [], warnings: [], ...overrides },
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
  return {
    request_id: 'req-face-1',
    face_match: { status: 'Approved', score: 92, warnings: [] },
  };
}

// ── Mock de Supabase: encola respuestas en el orden exacto en que el
//    servicio las pide (single/maybeSingle/then comparten un contador,
//    igual que en account-members.reopen.spec.ts). eq/neq quedan
//    espiados para poder afirmar sobre los filtros exactos que se
//    aplicaron — es la prueba directa del fix del bug 1. ────────────────

function mockSupabase(responses: Array<Record<string, unknown>>) {
  let call = 0;
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const eqCalls: Array<[string, unknown]> = [];

  const queryBuilder: Record<string, any> = {
    select: () => queryBuilder,
    update: (payload: Record<string, unknown>) => {
      updates.push(payload);
      return queryBuilder;
    },
    insert: (payload: Record<string, unknown>) => {
      inserts.push(payload);
      return queryBuilder;
    },
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return queryBuilder;
    },
    neq: () => queryBuilder,
    order: () => queryBuilder,
    single: () => Promise.resolve(responses[call++] ?? { data: null, error: null }),
    maybeSingle: () => Promise.resolve(responses[call++] ?? { data: null, error: null }),
    then: (resolve: (value: unknown) => unknown) =>
      resolve(responses[call++] ?? { data: null, error: null }),
  };

  const download = jest.fn((path: string) =>
    Promise.resolve({
      data: { arrayBuffer: () => Promise.resolve(new TextEncoder().encode(path).buffer) },
      error: null,
    }),
  );

  return {
    from: jest.fn(() => queryBuilder),
    storage: { from: jest.fn(() => ({ download })) },
    _updates: updates,
    _inserts: inserts,
    _eqCalls: eqCalls,
    _download: download,
  };
}

function mockDiditApiClient(overrides: {
  screenAml?: jest.Mock;
  verifyId?: jest.Mock;
  matchFaces?: jest.Mock;
} = {}) {
  return {
    screenAml: overrides.screenAml ?? jest.fn().mockResolvedValue(approvedAml()),
    verifyId: overrides.verifyId ?? jest.fn().mockResolvedValue(approvedIdVerification()),
    matchFaces: overrides.matchFaces ?? jest.fn().mockResolvedValue(approvedFaceMatch()),
  };
}

function buildService(supabase: unknown, diditApiClient: unknown): DiditVerificationService {
  return new DiditVerificationService(supabase as never, diditApiClient as never);
}

/** Invoca el método privado directamente — mismo patrón que el resto del proyecto. */
function runKyb(
  service: DiditVerificationService,
  args: {
    reviewId?: string;
    kybApplicationId?: string;
    actorId?: string;
    actorRole?: string;
    force?: boolean;
  } = {},
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
  nationality: 'BOL',
  id_number: '7654321',
};

function baseKyb(overrides: Record<string, unknown> = {}) {
  return {
    id: 'kyb-1',
    business_id: BUSINESS_ID,
    requester_user_id: 'user-1',
    screening: null,
    ...overrides,
  };
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

describe('DiditVerificationService — KYB', () => {
  afterEach(() => jest.clearAllMocks());

  it('reutiliza el veredicto guardado sin llamar a Didit cuando force=false', async () => {
    const cachedVerdict = { overall: 'approved', run_count: 1 };
    const supabase = mockSupabase([{ data: baseKyb({ screening: { didit: cachedVerdict } }), error: null }]);
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const result = await runKyb(service, { force: false });

    expect(result.reused).toBe(true);
    expect(result.verdict).toEqual(cachedVerdict);
    expect(diditApiClient.screenAml).not.toHaveBeenCalled();
    expect(diditApiClient.verifyId).not.toHaveBeenCalled();
  });

  it('aprueba solo cuando la empresa, el representante y todos los UBOs pasan', async () => {
    const supabase = mockSupabase([
      { data: baseKyb(), error: null }, // kyb_applications
      { data: baseBusiness(), error: null }, // businesses + directors + ubos
      {
        data: [
          { document_type: 'national_id_front', storage_path: `director/${DIRECTOR.id}/front.jpg`, mime_type: 'image/jpeg', file_size_bytes: 1000 },
          { document_type: 'selfie', storage_path: `director/${DIRECTOR.id}/selfie.jpg`, mime_type: 'image/jpeg', file_size_bytes: 1000 },
        ],
        error: null,
      }, // documents del director
      { error: null }, // persistKybVerdict
      { error: null }, // compliance_review_events insert
      { error: null }, // audit_logs insert
    ]);
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict, reused } = await runKyb(service);

    expect(reused).toBe(false);
    expect(verdict.overall).toBe('approved');
    expect(verdict.company_aml.status).toBe('Approved');
    expect(verdict.key_people).toHaveLength(2); // director + ubo
    // vendor_data distingue empresa / representante / cada UBO
    const vendorDatas = diditApiClient.screenAml.mock.calls.map((c: any[]) => c[0].vendorData);
    expect(vendorDatas).toEqual(
      expect.arrayContaining([
        'guira:kyb:kyb-1:company',
        'guira:kyb:kyb-1:director:director-1',
        'guira:kyb:kyb-1:ubo:ubo-1',
      ]),
    );
  });

  it('REGRESIÓN bug 1 — filtra los documentos por subject_type y subject_id del director, no solo por user_id', async () => {
    const supabase = mockSupabase([
      { data: baseKyb(), error: null },
      { data: baseBusiness(), error: null },
      { data: [], error: null }, // sin documentos — solo interesa comprobar los filtros aplicados
      { error: null },
      { error: null },
      { error: null },
    ]);
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    await runKyb(service);

    // Antes del fix, la consulta de documentos solo llevaba .eq('user_id', ...):
    // cualquier persona que compartiera user_id (otro director, un UBO) podía
    // contaminar el documento elegido. Ahora debe acotar también a la persona.
    expect(supabase._eqCalls).toContainEqual(['subject_type', 'director']);
    expect(supabase._eqCalls).toContainEqual(['subject_id', DIRECTOR.id]);
  });

  it('REGRESIÓN bug 2 — un fallo real en el AML del representante NUNCA produce overall=approved', async () => {
    const supabase = mockSupabase([
      { data: baseKyb(), error: null },
      { data: baseBusiness({ business_ubos: [] }), error: null }, // sin UBOs para aislar la variable
      { data: [], error: null },
      { error: null },
      { error: null },
      { error: null },
    ]);
    // screenAml se usa tanto para la empresa como para el representante;
    // se distingue por vendor_data para que solo el AML del director falle.
    const screenAml = jest.fn((input: { vendorData: string }) => {
      if (input.vendorData.includes(':director:')) {
        return Promise.reject(new Error('Didit no disponible'));
      }
      return Promise.resolve(approvedAml());
    });
    const diditApiClient = mockDiditApiClient({ screenAml });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    // Con el bug: companyAml Approved + (!directorAml || ...) vacuamente true
    // + sin UBOs + directorId/directorFace Approved → 'approved' a pesar del
    // fallo real. Con el fix: directorAml queda en null (no 'Skipped'), así
    // que allResults.every(r => r?.status === 'Approved') es false.
    expect(verdict.overall).toBe('needs_review');
    expect(verdict.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: 'director_aml' })]),
    );
  });

  it('sin representante legal registrado: no rompe, y no alcanza approved solo con empresa+UBOs', async () => {
    const supabase = mockSupabase([
      { data: baseKyb(), error: null },
      { data: baseBusiness({ business_directors: [] }), error: null },
      { error: null }, // persistKybVerdict (no hay consulta de documentos: no hay director)
      { error: null },
      { error: null },
    ]);
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(diditApiClient.verifyId).not.toHaveBeenCalled();
    expect(diditApiClient.matchFaces).not.toHaveBeenCalled();
    expect(verdict.id_verification?.status).toBe('Skipped');
    expect(verdict.face_match?.status).toBe('Skipped');
    // 'needs_review', no 'approved': un KYB sin representante identificado
    // no debe auto-aprobarse solo porque empresa y UBOs pasaron.
    expect(verdict.overall).toBe('needs_review');
  });

  it('un Declined de cualquier persona (UBO incluido) fuerza overall=declined', async () => {
    const supabase = mockSupabase([
      { data: baseKyb(), error: null },
      { data: baseBusiness(), error: null },
      { data: [], error: null },
      { error: null },
      { error: null },
      { error: null },
    ]);
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
    const supabase = mockSupabase([
      { data: baseKyb(), error: null },
      { data: baseBusiness(), error: null },
      // Con documentos presentes, id-verification y face-match SÍ se
      // intentan (si no hay documentos, se omiten como 'Skipped' antes de
      // llamar a Didit — ese es otro escenario, no "todo falló").
      {
        data: [
          { document_type: 'national_id_front', storage_path: `director/${DIRECTOR.id}/front.jpg`, mime_type: 'image/jpeg', file_size_bytes: 1000 },
          { document_type: 'selfie', storage_path: `director/${DIRECTOR.id}/selfie.jpg`, mime_type: 'image/jpeg', file_size_bytes: 1000 },
        ],
        error: null,
      },
      { error: null },
      { error: null },
      { error: null },
    ]);
    const screenAml = jest.fn().mockRejectedValue(new Error('Didit caído'));
    const verifyId = jest.fn().mockRejectedValue(new Error('Didit caído'));
    const matchFaces = jest.fn().mockRejectedValue(new Error('Didit caído'));
    const diditApiClient = mockDiditApiClient({ screenAml, verifyId, matchFaces });
    const service = buildService(supabase, diditApiClient);

    const { verdict } = await runKyb(service);

    expect(verdict.overall).toBe('error');
  });

  it('lanza ConflictException si ya hay una verificación en curso para el mismo expediente', async () => {
    // El guard `inFlight.add(...)` corre de forma síncrona antes del primer
    // `await` de la función, así que basta con NO esperar la primera
    // llamada antes de disparar la segunda: la segunda debe rechazar de
    // inmediato al ver el lock ya tomado.
    const supabase = mockSupabase([{ data: baseKyb(), error: null }]);
    const diditApiClient = mockDiditApiClient();
    const service = buildService(supabase, diditApiClient);

    const first = runKyb(service, { kybApplicationId: 'kyb-locked' });

    await expect(runKyb(service, { kybApplicationId: 'kyb-locked' })).rejects.toThrow(
      'Ya hay una verificación de Didit en curso',
    );

    await first.catch(() => undefined);
  });
});

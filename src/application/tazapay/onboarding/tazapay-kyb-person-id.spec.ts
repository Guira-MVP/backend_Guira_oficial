import {
  assignPersonIds,
  TazapayKybOnboardingService,
} from './tazapay-kyb-onboarding.service';

/**
 * Sin person_id, el PUT y el submit de Tazapay toman a cada representante
 * como una persona nueva y la entity queda duplicada (sandbox 2026-10-05).
 */
describe('Tazapay KYB — person_id de los representantes', () => {
  it('empareja por nombre, sin tildes ni mayúsculas, y usa cada id una vez', () => {
    expect(
      assignPersonIds(
        [
          { first_name: 'Martha Yesenia', last_name: 'Tambo Morales' },
          { first_name: 'Ana', last_name: 'Quispe' },
          { first_name: 'Carlos', last_name: 'Mamani' },
        ],
        [
          { person_id: 'psn_ana', first_name: 'ANA', last_name: 'QUISPE' },
          {
            person_id: 'psn_martha',
            first_name: 'Martha Yesenia',
            last_name: 'Tambo Morales',
          },
        ],
      ),
    ).toEqual(['psn_martha', 'psn_ana', undefined]);

    // Nombre con tilde en Guira, sin tilde en Tazapay.
    expect(
      assignPersonIds(
        [{ first_name: 'José', last_name: 'Peñaranda' }],
        [{ person_id: 'psn_1', first_name: 'Jose', last_name: 'Penaranda' }],
      ),
    ).toEqual(['psn_1']);

    // Sin nombre en la respuesta: por posición.
    expect(
      assignPersonIds(
        [{ first_name: 'Ana' }],
        [{ person_id: 'psn_x', first_name: null }],
      ),
    ).toEqual(['psn_x']);

    // Entity sin representantes todavía: todos van como nuevos.
    expect(assignPersonIds([{ first_name: 'Ana' }], [])).toEqual([undefined]);
  });

  it('el PUT y el submit llevan el person_id de la representante existente', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const api = {
      isConfigured: true,
      get: jest.fn((path: string) => {
        calls.push({ method: 'GET', path });
        return Promise.resolve({
          data: {
            representatives: [
              {
                person_id: 'psn_martha',
                first_name: 'Martha Yesenia',
                last_name: 'Tambo Morales',
              },
            ],
          },
        });
      }),
      put: jest.fn((path: string, body: unknown) => {
        calls.push({ method: 'PUT', path, body });
        return Promise.resolve({});
      }),
      post: jest.fn((path: string, body: unknown) => {
        calls.push({ method: 'POST', path, body });
        return Promise.resolve({ data: { approval_status: 'submitted' } });
      }),
    };
    const supabase = {
      from: () => {
        const b: Record<string, unknown> = {};
        Object.assign(b, {
          update: () => b,
          eq: () => Promise.resolve({ error: null }),
        });
        return b;
      },
    };

    const service = Object.create(
      TazapayKybOnboardingService.prototype,
    ) as TazapayKybOnboardingService;
    Object.assign(service, {
      api,
      supabase,
      uploader: { uploadOne: jest.fn() },
    });
    const ctx = {
      userId: 'u-1',
      business: {
        id: 'b-1',
        legal_name: 'Devwolf',
        entity_type: 'sole_prop',
        registration_number: '10060025',
        address1: 'Calle Jose Astete 104',
        city: 'La Paz',
        state: 'L',
        country: 'BOL',
        tazapay_vertical: 'Software as a Service - Other Software as a Service',
        tazapay_vertical_confirmed_at: '2026-10-03T00:00:00Z',
      },
      directors: [
        {
          id: 'd-1',
          first_name: 'Martha Yesenia',
          last_name: 'Tambo Morales',
          date_of_birth: '1998-02-01',
          nationality: 'BOL',
          is_director: true,
          address1: 'Calle Jose Astete 104',
          city: 'La Paz',
          country: 'BOL',
        },
      ],
      ubos: [
        {
          id: 'u-ubo',
          director_id: 'd-1',
          first_name: 'Martha Yesenia',
          last_name: 'Tambo Morales',
          ownership_percent: 100,
        },
      ],
      documents: [],
    };
    jest.spyOn(service, 'loadContext').mockResolvedValue(ctx as never);
    jest.spyOn(service, 'missingForTazapay').mockReturnValue([]);

    await service.run({
      id: 'sub-1',
      user_id: 'u-1',
      kyb_application_id: 'kyb-1',
      external_id: 'ent_1', // la entity ya existe (reintento o tras el create)
      idempotency_key: 'tazapay:kyb-1',
      attempt_count: 1,
    });

    const put = calls.find((c) => c.method === 'PUT');
    const submit = calls.find(
      (c) => c.method === 'POST' && c.path.endsWith('/submit'),
    );
    for (const call of [put, submit]) {
      const reps = (call?.body as { representatives: unknown[] })
        .representatives as Array<{ person_id?: string }>;
      // Una sola persona (representante y socia fusionadas), con su person_id.
      expect(reps).toHaveLength(1);
      expect(reps[0].person_id).toBe('psn_martha');
    }
    // Se lee la entity antes del PUT.
    const getIdx = calls.findIndex((c) => c.method === 'GET');
    const putIdx = calls.findIndex((c) => c.method === 'PUT');
    expect(getIdx).toBeGreaterThanOrEqual(0);
    expect(getIdx).toBeLessThan(putIdx);
  });
});

import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  OnboardingDraftService,
  stableStringify,
  __test__,
} from './onboarding-draft.service';

/**
 * Borrador persistente del onboarding: el formulario lo guarda mientras el
 * cliente escribe, sin enviar nada a revisión.
 *
 * Lo que se protege aquí:
 *  - un autosave rezagado no debe resucitar el borrador de un expediente que
 *    ya está en manos del staff (409);
 *  - reenviar lo mismo no reescribe ni avisa al staff;
 *  - el JSON del cliente se limpia (claves peligrosas, tamaño);
 *  - al enviar, los documentos dejan de ser borrador y la copia se borra.
 */

type Result = { data: unknown; error: unknown; count?: number };

function mockSupabase(results: Record<string, Result | Result[]>) {
  const calls: Array<{ table: string; op: string; payload?: unknown; filters: unknown[][] }> = [];
  const removed: string[][] = [];

  const next = (table: string): Result => {
    const r = results[table];
    if (Array.isArray(r)) return r.length > 1 ? r.shift()! : r[0];
    return r ?? { data: null, error: null };
  };

  const client = {
    calls,
    removed,
    storage: {
      from: () => ({
        remove: (paths: string[]) => {
          removed.push(paths);
          return Promise.resolve({ data: null, error: null });
        },
      }),
    },
    from(table: string) {
      const call = { table, op: 'select', payload: undefined as unknown, filters: [] as unknown[][] };
      calls.push(call);
      const builder: any = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        range: () => builder,
        lt: (...a: unknown[]) => (call.filters.push(['lt', ...a]), builder),
        eq: (...a: unknown[]) => (call.filters.push(['eq', ...a]), builder),
        in: (...a: unknown[]) => (call.filters.push(['in', ...a]), builder),
        upsert: (payload: unknown) => ((call.op = 'upsert'), (call.payload = payload), builder),
        update: (payload: unknown) => ((call.op = 'update'), (call.payload = payload), builder),
        delete: () => ((call.op = 'delete'), builder),
        maybeSingle: () => Promise.resolve(next(table)),
        single: () => Promise.resolve(next(table)),
        then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(next(table)).then(resolve, reject),
      };
      return builder;
    },
  };
  return client;
}

function buildService(supabase: unknown) {
  const gateway = { emitOnboardingDraftUpdated: jest.fn() };
  const service = new OnboardingDraftService(supabase as never, gateway as never);
  return { service, gateway };
}

const baseDto = {
  type: 'personal' as const,
  step: 3,
  data: { first_name: 'Ana', last_name: 'Pérez' },
  missing_fields: [{ key: 'city', label: 'Ciudad', step: 3, reason: 'missing', message: 'Requerido' }],
  progress_pct: 40,
};

describe('OnboardingDraftService.saveDraft', () => {
  it('rechaza con 409 si la solicitud ya fue enviada', async () => {
    const supabase = mockSupabase({
      kyc_applications: { data: { status: 'submitted', created_at: '2026-09-20' }, error: null },
      kyb_applications: { data: null, error: null },
    });
    const { service } = buildService(supabase);

    await expect(service.saveDraft('u1', baseDto)).rejects.toBeInstanceOf(ConflictException);
    expect(supabase.calls.some((c) => c.op === 'upsert')).toBe(false);
  });

  it('permite editar en needs_review (el staff pidió correcciones)', async () => {
    const supabase = mockSupabase({
      kyc_applications: { data: { status: 'needs_review', created_at: '2026-09-20' }, error: null },
      kyb_applications: { data: null, error: null },
      onboarding_drafts: [
        { data: null, error: null },
        { data: { updated_at: '2026-09-23T10:00:00Z' }, error: null },
      ],
    });
    const { service, gateway } = buildService(supabase);

    const res = await service.saveDraft('u1', baseDto);
    expect(res.unchanged).toBe(false);
    const upsert = supabase.calls.find((c) => c.op === 'upsert');
    expect(upsert?.payload).toMatchObject({ user_id: 'u1', type: 'personal', step: 3, progress_pct: 40 });
    expect(gateway.emitOnboardingDraftUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'u1', action: 'saved', progress_pct: 40 }),
    );
    // Sin PII en el socket del staff.
    expect(gateway.emitOnboardingDraftUpdated.mock.calls[0][0]).not.toHaveProperty('data');
  });

  it('no reescribe si el payload es idéntico al guardado (aunque jsonb reordene claves)', async () => {
    const stored = {
      user_id: 'u1',
      type: 'personal',
      step: 3,
      data: { last_name: 'Pérez', first_name: 'Ana' },
      missing_fields: baseDto.missing_fields,
      progress_pct: 40,
      updated_at: '2026-09-23T09:00:00Z',
    };
    const supabase = mockSupabase({
      kyc_applications: { data: null, error: null },
      kyb_applications: { data: null, error: null },
      onboarding_drafts: { data: stored, error: null },
    });
    const { service, gateway } = buildService(supabase);

    const res = await service.saveDraft('u1', baseDto);
    expect(res).toEqual({ updated_at: stored.updated_at, unchanged: true });
    expect(supabase.calls.some((c) => c.op === 'upsert')).toBe(false);
    expect(gateway.emitOnboardingDraftUpdated).not.toHaveBeenCalled();
  });

  it('avisa al staff como máximo una vez por ventana de throttle', async () => {
    const supabase = mockSupabase({
      kyc_applications: { data: null, error: null },
      kyb_applications: { data: null, error: null },
      onboarding_drafts: [
        { data: null, error: null },
        { data: { updated_at: 't1' }, error: null },
        { data: null, error: null },
        { data: { updated_at: 't2' }, error: null },
      ],
    });
    const { service, gateway } = buildService(supabase);

    await service.saveDraft('u1', baseDto);
    await service.saveDraft('u1', { ...baseDto, step: 4 });
    expect(gateway.emitOnboardingDraftUpdated).toHaveBeenCalledTimes(1);
  });

  it('rechaza borradores que exceden el tamaño permitido', async () => {
    const supabase = mockSupabase({
      kyc_applications: { data: null, error: null },
      kyb_applications: { data: null, error: null },
    });
    const { service } = buildService(supabase);
    const big: Record<string, string> = {};
    for (let i = 0; i < 20; i++) big[`field_${i}`] = 'x'.repeat(4000);

    await expect(service.saveDraft('u1', { ...baseDto, data: big })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('sanitización del JSON del cliente', () => {
  const { sanitizeValue } = __test__;

  it('descarta claves peligrosas o con formato inesperado', () => {
    const input = JSON.parse(
      '{"first_name":"Ana","__proto__":{"admin":true},"constructor":1,"Bad-Key":2,"ubos":[{"email":"a@b.co","__proto__":1}]}',
    );
    const out = sanitizeValue(input, 0) as Record<string, unknown>;
    expect(out).toEqual({ first_name: 'Ana', constructor: 1, ubos: [{ email: 'a@b.co' }] });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('corta profundidad, arreglos y textos largos', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(sanitizeValue(deep, 0)).toEqual({ a: { b: { c: { d: null } } } });
    const arr = sanitizeValue(Array.from({ length: 80 }, (_, i) => i), 0) as unknown[];
    expect(arr).toHaveLength(50);
    expect((sanitizeValue('x'.repeat(6000), 0) as string).length).toBe(5000);
  });

  it('stableStringify no depende del orden de las claves', () => {
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      stableStringify({ a: [{ c: 2, d: 1 }], b: 1 }),
    );
  });
});

describe('OnboardingDraftService.markSubmitted', () => {
  it('marca los documentos como enviados y borra el borrador', async () => {
    const supabase = mockSupabase({});
    const { service, gateway } = buildService(supabase);

    await service.markSubmitted('u1');

    const docsUpdate = supabase.calls.find((c) => c.table === 'documents' && c.op === 'update');
    expect(docsUpdate?.payload).toEqual({ is_draft: false });
    expect(docsUpdate?.filters).toContainEqual(['eq', 'user_id', 'u1']);
    expect(
      supabase.calls.some((c) => c.table === 'onboarding_drafts' && c.op === 'delete'),
    ).toBe(true);
    expect(gateway.emitOnboardingDraftUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'deleted' }),
    );
  });

  it('no propaga errores: el envío ya se hizo', async () => {
    const supabase = mockSupabase({ documents: { data: null, error: new Error('db caída') } });
    const { service } = buildService(supabase);
    await expect(service.markSubmitted('u1')).resolves.toBeUndefined();
  });
});

describe('OnboardingDraftService.deleteDraft', () => {
  it('con withDocuments borra de Storage los documentos de borrador', async () => {
    const supabase = mockSupabase({
      documents: [
        { data: [{ id: 'd1', storage_path: 'u1/a.jpg' }, { id: 'd2', storage_path: 'u1/b.pdf' }], error: null },
        { data: null, error: null },
      ],
    });
    const { service } = buildService(supabase);

    await service.deleteDraft('u1', { withDocuments: true });

    expect(supabase.removed).toEqual([['u1/a.jpg', 'u1/b.pdf']]);
    const listCall = supabase.calls.find((c) => c.table === 'documents' && c.op === 'select');
    expect(listCall?.filters).toContainEqual(['eq', 'is_draft', true]);
    expect(supabase.calls.some((c) => c.table === 'documents' && c.op === 'delete')).toBe(true);
  });
});

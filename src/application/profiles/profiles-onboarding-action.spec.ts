import { ProfilesService } from './profiles.service';

/**
 * onboarding_action_required decide si el cliente entra al onboarding o al
 * panel. Es solo enrutado: ante errores debe devolver false (el panel sigue
 * mostrando el aviso con la salida al onboarding) y nunca bloquear el login.
 */

type Result = { data?: unknown; error?: unknown; count?: number };

function setup(results: {
  profile: Record<string, unknown>;
  draft?: Result;
  kycNeedsReview?: number;
  kybNeedsReview?: number;
  failApplications?: boolean;
}) {
  const queried: string[] = [];
  const supabase = {
    from: (table: string) => {
      queried.push(table);
      const b: Record<string, unknown> = {};
      const resolveFor = (): Result => {
        if (table === 'onboarding_drafts')
          return results.draft ?? { data: null, error: null };
        if (table === 'kyc_applications')
          return results.failApplications
            ? { count: undefined, error: { message: 'boom' } }
            : { count: results.kycNeedsReview ?? 0, error: null };
        if (table === 'kyb_applications')
          return { count: results.kybNeedsReview ?? 0, error: null };
        if (table === 'account_members') return { count: 0, error: null };
        return { data: null, error: null };
      };
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        single: () => Promise.resolve({ data: results.profile, error: null }),
        maybeSingle: () => Promise.resolve(resolveFor()),
        then: (resolve: (v: unknown) => unknown) => resolve(resolveFor()),
      });
      return b;
    },
  };
  const service = new ProfilesService(
    supabase as never,
    {} as never,
    { get: () => '' } as never,
  );
  return { service, queried };
}

const pending = {
  id: 'u1',
  email: 'a@b.com',
  onboarding_status: 'kyb_started',
};

describe('ProfilesService.findOne — onboarding_action_required', () => {
  it('aprobado: siempre false y sin consultas extra', async () => {
    const { service, queried } = setup({
      profile: { ...pending, onboarding_status: 'approved' },
    });
    const me = await service.findOne('u1');
    expect(me.onboarding_action_required).toBe(false);
    expect(queried).not.toContain('onboarding_drafts');
  });

  it('true si el staff dejó lista la solicitud asistida', async () => {
    const { service } = setup({
      profile: pending,
      draft: {
        data: { assisted_ready_at: '2026-09-28T10:00:00Z' },
        error: null,
      },
    });
    expect((await service.findOne('u1')).onboarding_action_required).toBe(true);
  });

  it('true si compliance pidió correcciones (needs_review)', async () => {
    const { service } = setup({ profile: pending, kybNeedsReview: 1 });
    expect((await service.findOne('u1')).onboarding_action_required).toBe(true);
  });

  it('false sin nada pendiente', async () => {
    const { service } = setup({ profile: pending });
    expect((await service.findOne('u1')).onboarding_action_required).toBe(
      false,
    );
  });

  it('ante errores de consulta degrada a false sin romper el perfil', async () => {
    const { service } = setup({
      profile: pending,
      draft: { data: null, error: { message: 'column does not exist' } },
      failApplications: true,
    });
    const me = await service.findOne('u1');
    expect(me.onboarding_action_required).toBe(false);
    expect(me.id).toBe('u1');
  });
});

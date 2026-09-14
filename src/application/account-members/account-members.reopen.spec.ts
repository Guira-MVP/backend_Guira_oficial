import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AccountMembersService } from './account-members.service';

/**
 * Pruebas de reabrir una invitación y de la barrera de onboarding.
 *
 * Reabrir existe porque sin ello el sistema se atasca: el índice único
 * `account_members_unique_live` cubre (owner_id, correo) para pending y
 * active, de modo que si el correo se perdió y la invitación sigue
 * pendiente, invitar otra vez devuelve 23505. La única salida era «Retirar
 * acceso» —cuyo diálogo afirma algo falso— y volver a empezar.
 *
 * Reutiliza la MISMA fila a propósito: un contador que entra y sale cuatro
 * veces sigue siendo una línea en la lista, no cuatro.
 */

const OWNER = {
  id: 'owner-1',
  email: 'titular@empresa.com',
  profile: { role: 'client', full_name: 'Empresa Uno' },
} as never;

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    owner_id: 'owner-1',
    member_id: null,
    invited_email: 'contador@externo.com',
    full_name: 'Ana Pérez',
    preset: 'finance',
    capabilities: ['orders:read', 'activity:read'],
    status: 'pending',
    created_at: '2026-09-01T00:00:00Z',
    expires_at: '2026-09-08T00:00:00Z',
    accepted_at: null,
    ...overrides,
  };
}

/**
 * Supabase simulado. `responses` alimenta en orden las consultas que hace
 * el servicio; `updates` recoge lo que se escribió para poder afirmar sobre
 * ello.
 */
function mockSupabase(responses: Array<Record<string, unknown>>) {
  let call = 0;
  const updates: Array<Record<string, unknown>> = [];

  const builder: Record<string, any> = {
    updates,
    from: () => builder,
    select: () => builder,
    insert: () => builder,
    update: (payload: Record<string, unknown>) => {
      updates.push(payload);
      return builder;
    },
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    lt: () => builder,
    order: () => builder,
    limit: () => builder,
    single: () => Promise.resolve(responses[call++] ?? { data: null, error: null }),
    maybeSingle: () =>
      Promise.resolve(responses[call++] ?? { data: null, error: null }),
    then: (resolve: (value: unknown) => unknown) =>
      resolve(responses[call++] ?? { data: null, error: null, count: 0 }),
  };

  return builder;
}

function buildService(
  supabase: unknown,
  opts: { throttle?: unknown; emailSent?: boolean } = {},
): AccountMembersService {
  const service = new AccountMembersService(
    supabase as never,
    { get: () => 'http://localhost:3000' } as never,
    {
      sendTeamInviteEmail: () => Promise.resolve(opts.emailSent ?? true),
    } as never,
    (opts.throttle ?? { consume: () => Promise.resolve() }) as never,
  );

  return service;
}

describe('assertCanInvite — barrera de onboarding', () => {
  /**
   * La pantalla /equipo ya exige `approved`, pero el endpoint no lo
   * comprobaba: con un JWT válido, una cuenta sin KYB podía hacer que Guira
   * enviara correos con su marca a cualquier dirección.
   */
  function callAssert(service: AccountMembersService) {
    return (
      service as unknown as {
        assertCanInvite: (actor: unknown) => Promise<void>;
      }
    ).assertCanInvite(OWNER);
  }

  it('deja invitar a una cuenta aprobada', async () => {
    const supabase = mockSupabase([
      { data: { onboarding_status: 'approved' }, error: null },
    ]);
    await expect(callAssert(buildService(supabase))).resolves.toBeUndefined();
  });

  it.each(['pending', 'in_review', 'kyb_submitted', 'rejected'])(
    'RECHAZA a una cuenta con onboarding "%s"',
    async (status) => {
      const supabase = mockSupabase([
        { data: { onboarding_status: status }, error: null },
      ]);
      await expect(callAssert(buildService(supabase))).rejects.toThrow(
        ForbiddenException,
      );
    },
  );

  it('RECHAZA si no se puede leer el perfil (falla cerrado)', async () => {
    const supabase = mockSupabase([
      { data: null, error: { message: 'timeout' } },
    ]);
    await expect(callAssert(buildService(supabase))).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('reopen', () => {
  it('RECHAZA reabrir sobre alguien que ya tiene acceso', async () => {
    const supabase = mockSupabase([
      { data: baseRow({ status: 'active', member_id: 'user-9' }), error: null },
    ]);

    await expect(
      buildService(supabase).reopen(OWNER, 'row-1', {}),
    ).rejects.toThrow(BadRequestException);
  });

  it('consume cupo ANTES de tocar la fila', async () => {
    // Si el cupo está agotado no debe cambiar nada: la invitación que ya se
    // mandó tiene que seguir siendo válida.
    const consume = jest.fn(() => Promise.reject(new Error('429')));
    const supabase = mockSupabase([
      { data: baseRow(), error: null },
      { data: { onboarding_status: 'approved' }, error: null },
    ]);

    await expect(
      buildService(supabase, { throttle: { consume } }).reopen(
        OWNER,
        'row-1',
        {},
      ),
    ).rejects.toThrow();

    expect(consume).toHaveBeenCalledWith('owner-1', 'contador@externo.com');
    expect(supabase.updates).toEqual([]);
  });

  it('genera un token distinto en cada reapertura', async () => {
    // Un enlace viejo filtrado deja de servir en cuanto se reabre.
    async function reopenOnce() {
      const supabase = mockSupabase([
        { data: baseRow(), error: null }, // findOwnedRow
        { data: { onboarding_status: 'approved' }, error: null },
        { count: 0 }, // plazas ocupadas
        { data: baseRow(), error: null }, // update ... select
      ]);
      await buildService(supabase).reopen(OWNER, 'row-1', {});
      return supabase.updates.at(-1)?.invitation_token_hash as string;
    }

    const first = await reopenOnce();
    const second = await reopenOnce();

    expect(first).toBeDefined();
    expect(first).not.toEqual(second);
  });

  it('sin preset conserva los permisos a medida (reenviar con "custom")', async () => {
    const supabase = mockSupabase([
      {
        data: baseRow({
          preset: 'custom',
          capabilities: ['orders:read', 'balances:read'],
        }),
        error: null,
      },
      { data: { onboarding_status: 'approved' }, error: null },
      { count: 0 },
      { data: baseRow(), error: null },
    ]);

    await buildService(supabase).reopen(OWNER, 'row-1', {});

    const payload = supabase.updates.at(-1)!;
    expect(payload.capabilities).toEqual(['orders:read', 'balances:read']);
    expect(payload.status).toBe('pending');
  });

  it('con plantilla con nombre, los permisos se rederivan del catálogo', async () => {
    // Invariante heredado de `resolveCapabilities`: con plantilla manda el
    // catálogo, no lo que haya guardado en la fila. Así una plantilla que
    // cambie de contenido se aplica igual al reabrir, y la etiqueta
    // guardada nunca miente sobre los permisos reales.
    const supabase = mockSupabase([
      { data: baseRow({ preset: 'operations', capabilities: [] }), error: null },
      { data: { onboarding_status: 'approved' }, error: null },
      { count: 0 },
      { data: baseRow(), error: null },
    ]);

    await buildService(supabase).reopen(OWNER, 'row-1', {});

    const payload = supabase.updates.at(-1) as Record<string, string[]>;
    expect(payload.capabilities).toEqual(['orders:read', 'activity:read']);
  });

  it('con preset reemplaza los permisos (volver a invitar)', async () => {
    const supabase = mockSupabase([
      { data: baseRow({ status: 'revoked', member_id: 'user-9' }), error: null },
      { data: { onboarding_status: 'approved' }, error: null },
      { count: 0 },
      { data: baseRow(), error: null },
    ]);

    await buildService(supabase).reopen(OWNER, 'row-1', {
      preset: 'operations',
    });

    const payload = supabase.updates.at(-1)!;
    expect(payload.preset).toBe('operations');
    expect(payload.capabilities).toEqual(['orders:read', 'activity:read']);
  });

  it('re-resuelve los permisos contra el catálogo ACTUAL', async () => {
    // Si un permiso se retiró del catálogo desde que se concedió —como pasó
    // con `compliance:read`—, reabrir a ciegas lo reintroduciría.
    const supabase = mockSupabase([
      {
        data: baseRow({
          capabilities: ['orders:read', 'compliance:read'],
        }),
        error: null,
      },
      { data: { onboarding_status: 'approved' }, error: null },
      { count: 0 },
      { data: baseRow(), error: null },
    ]);

    await buildService(supabase).reopen(OWNER, 'row-1', {});

    const payload = supabase.updates.at(-1)!;
    expect(payload.capabilities).not.toContain('compliance:read');
  });

  it('limpia el rastro de la revocación anterior', async () => {
    const supabase = mockSupabase([
      {
        data: baseRow({
          status: 'revoked',
          member_id: 'user-9',
          revoked_at: '2026-09-05T00:00:00Z',
          revoke_reason: 'cierre trimestral',
        }),
        error: null,
      },
      { data: { onboarding_status: 'approved' }, error: null },
      { count: 0 },
      { data: baseRow(), error: null },
    ]);

    await buildService(supabase).reopen(OWNER, 'row-1', { preset: 'finance' });

    const payload = supabase.updates.at(-1)!;
    expect(payload.revoked_at).toBeNull();
    expect(payload.revoked_by).toBeNull();
    expect(payload.revoke_reason).toBeNull();
  });

  it('renueva el plazo hacia el futuro', async () => {
    const supabase = mockSupabase([
      { data: baseRow({ expires_at: '2020-01-01T00:00:00Z' }), error: null },
      { data: { onboarding_status: 'approved' }, error: null },
      { count: 0 },
      { data: baseRow(), error: null },
    ]);

    await buildService(supabase).reopen(OWNER, 'row-1', {});

    const renewed = new Date(supabase.updates.at(-1)!.expires_at as string);
    expect(renewed.getTime()).toBeGreaterThan(Date.now());
  });

  it('RECHAZA si ya hay otra invitación viva para ese correo', async () => {
    const supabase = mockSupabase([
      { data: baseRow({ status: 'revoked', member_id: 'user-9' }), error: null },
      { data: { onboarding_status: 'approved' }, error: null },
      { count: 0 },
      { data: null, error: { code: '23505', message: 'duplicate key' } },
    ]);

    await expect(
      buildService(supabase).reopen(OWNER, 'row-1', { preset: 'finance' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('RECHAZA si la cuenta perdió la aprobación entre medias', async () => {
    const supabase = mockSupabase([
      { data: baseRow(), error: null },
      { data: { onboarding_status: 'in_review' }, error: null },
    ]);

    await expect(
      buildService(supabase).reopen(OWNER, 'row-1', {}),
    ).rejects.toThrow(ForbiddenException);
    expect(supabase.updates).toEqual([]);
  });
});

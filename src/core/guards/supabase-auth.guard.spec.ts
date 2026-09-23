import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import {
  ACTING_FOR_HEADER,
  AuthenticatedUser,
  SupabaseAuthGuard,
} from './supabase-auth.guard';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

/**
 * SupabaseAuthGuard es global: corre en todas las rutas. Staging le añadió
 * la resolución del acceso vinculado, así que estas pruebas fijan dos cosas:
 *  1. Sin la cabecera `x-guira-acting-for`, se comporta igual que en main.
 *  2. Con la cabecera, solo un cliente con vínculo activo sobre una cuenta
 *     operativa obtiene contexto; cualquier otro caso es 403.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown> | null;

interface DbState {
  profile?: Row;
  profileError?: { code: string; message: string } | null;
  ownerProfile?: Row;
  membership?: Row;
  membershipError?: { code: string; message: string } | null;
  staff?: Row;
  staffError?: { code: string; message: string } | null;
}

const ACTIVE_CLIENT_PROFILE = {
  role: 'client',
  onboarding_status: 'approved',
  is_active: true,
  is_frozen: false,
  frozen_reason: null,
  bridge_customer_id: 'cus_1',
  full_name: 'Cliente Uno',
};

function buildGuard(state: DbState, opts: { isPublic?: boolean } = {}) {
  const tables: string[] = [];

  const supabase: any = {
    from: jest.fn((table: string) => {
      tables.push(table);
      const filters: Record<string, unknown> = {};
      const builder: any = {
        select: jest.fn(() => builder),
        eq: jest.fn((col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        }),
        single: jest.fn(() => {
          if (table === 'profiles' && filters.id === OWNER_ID) {
            return Promise.resolve({ data: state.ownerProfile ?? null, error: null });
          }
          return Promise.resolve({
            data: state.profileError ? null : (state.profile ?? null),
            error: state.profileError ?? null,
          });
        }),
        maybeSingle: jest.fn(() =>
          Promise.resolve({
            data: state.membershipError ? null : (state.membership ?? null),
            error: state.membershipError ?? null,
          }),
        ),
      };
      return builder;
    }),
    rpc: jest.fn(() =>
      Promise.resolve({ data: state.staff ?? null, error: state.staffError ?? null }),
    ),
  };

  const reflector: any = { getAllAndOverride: jest.fn(() => opts.isPublic ?? false) };
  const config: any = { get: jest.fn(() => 'x') };

  return { guard: new SupabaseAuthGuard(supabase, reflector, config), supabase, tables };
}

function mockJwt(user: { id: string; email?: string } | null) {
  (createClient as jest.Mock).mockReturnValue({
    auth: {
      getUser: jest.fn(() =>
        Promise.resolve(
          user
            ? { data: { user }, error: null }
            : { data: { user: null }, error: { message: 'invalid' } },
        ),
      ),
    },
  });
}

function makeContext(headers: Record<string, string>) {
  const request: { headers: Record<string, string>; user?: AuthenticatedUser } = {
    headers,
  };
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

const BEARER = { authorization: 'Bearer token-valido' };

beforeEach(() => {
  jest.clearAllMocks();
  mockJwt({ id: USER_ID, email: 'cliente@example.com' });
});

describe('SupabaseAuthGuard — comportamiento de main (sin cabecera de acceso vinculado)', () => {
  it('una ruta @Public pasa sin token ni consultas', async () => {
    const { guard, supabase } = buildGuard({}, { isPublic: true });
    const { context } = makeContext({});

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('sin Bearer responde 401', async () => {
    const { guard } = buildGuard({ profile: ACTIVE_CLIENT_PROFILE });
    const { context } = makeContext({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('un token inválido responde 401', async () => {
    mockJwt(null);
    const { guard } = buildGuard({ profile: ACTIVE_CLIENT_PROFILE });
    const { context } = makeContext(BEARER);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('un cliente normal recibe el mismo usuario que en main y linkedAccess=null', async () => {
    const { guard } = buildGuard({ profile: ACTIVE_CLIENT_PROFILE });
    const { context, request } = makeContext(BEARER);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: USER_ID,
      email: 'cliente@example.com',
      profile: {
        role: 'client',
        onboarding_status: 'approved',
        is_active: true,
        is_frozen: false,
        frozen_reason: null,
        bridge_customer_id: 'cus_1',
        full_name: 'Cliente Uno',
      },
      linkedAccess: null,
    });
  });

  it('sin cabecera NO consulta account_members (el caso normal no paga queries extra)', async () => {
    const { guard, tables } = buildGuard({ profile: ACTIVE_CLIENT_PROFILE });
    const { context } = makeContext(BEARER);

    await guard.canActivate(context);
    expect(tables).toEqual(['profiles']);
  });

  it('el rol de staff sigue saliendo de staff_get, no de profiles.role', async () => {
    const { guard } = buildGuard({
      profile: { ...ACTIVE_CLIENT_PROFILE, role: 'super_admin' },
      staff: { role: 'staff', is_active: true },
    });
    const { context, request } = makeContext(BEARER);

    await guard.canActivate(context);
    expect(request.user?.profile.role).toBe('staff');
    expect(request.user?.linkedAccess).toBeNull();
  });

  it('si staff_get falla, degrada a cliente (nunca concede staff por defecto)', async () => {
    const { guard } = buildGuard({
      profile: ACTIVE_CLIENT_PROFILE,
      staffError: { code: 'XX', message: 'caído' },
    });
    const { context, request } = makeContext(BEARER);

    await guard.canActivate(context);
    expect(request.user?.profile.role).toBe('client');
  });

  it('una cuenta inactiva responde 403', async () => {
    const { guard } = buildGuard({ profile: { ...ACTIVE_CLIENT_PROFILE, is_active: false } });
    const { context } = makeContext(BEARER);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una cuenta congelada responde 403', async () => {
    const { guard } = buildGuard({
      profile: { ...ACTIVE_CLIENT_PROFILE, is_frozen: true, frozen_reason: 'revisión' },
    });
    const { context } = makeContext(BEARER);

    await expect(guard.canActivate(context)).rejects.toThrow('Cuenta congelada: revisión');
  });

  it('sin perfil responde 401', async () => {
    const { guard } = buildGuard({ profileError: { code: 'PGRST116', message: 'no rows' } });
    const { context } = makeContext(BEARER);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('SupabaseAuthGuard — acceso vinculado (solo staging)', () => {
  const withHeader = (value: string) => ({ ...BEARER, [ACTING_FOR_HEADER]: value });

  it('un cliente con vínculo activo obtiene el contexto, y su id/perfil siguen siendo los propios', async () => {
    const { guard } = buildGuard({
      profile: ACTIVE_CLIENT_PROFILE,
      membership: { capabilities: ['orders:read'] },
      ownerProfile: { is_active: true, is_frozen: false },
    });
    const { context, request } = makeContext(withHeader(OWNER_ID));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user?.id).toBe(USER_ID);
    expect(request.user?.linkedAccess).toEqual({
      ownerId: OWNER_ID,
      source: 'team_member',
      capabilities: ['orders:read'],
    });
  });

  it('el personal interno no puede usar el acceso vinculado', async () => {
    const { guard, tables } = buildGuard({
      profile: ACTIVE_CLIENT_PROFILE,
      staff: { role: 'admin', is_active: true },
    });
    const { context } = makeContext(withHeader(OWNER_ID));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tables).not.toContain('account_members');
  });

  it('un valor que no es UUID responde 403 sin llegar a consultar', async () => {
    const { guard, tables } = buildGuard({ profile: ACTIVE_CLIENT_PROFILE });
    const { context } = makeContext(withHeader("x' or 1=1 --"));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tables).not.toContain('account_members');
  });

  it('sin vínculo activo responde 403 (no degrada en silencio a la cuenta propia)', async () => {
    const { guard } = buildGuard({ profile: ACTIVE_CLIENT_PROFILE, membership: null });
    const { context, request } = makeContext(withHeader(OWNER_ID));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(request.user).toBeUndefined();
  });

  it('si falla la consulta del vínculo responde 403', async () => {
    const { guard } = buildGuard({
      profile: ACTIVE_CLIENT_PROFILE,
      membershipError: { code: '42P01', message: 'relation does not exist' },
    });
    const { context } = makeContext(withHeader(OWNER_ID));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    ['inactiva', { is_active: false, is_frozen: false }],
    ['congelada', { is_active: true, is_frozen: true }],
    ['inexistente', null],
  ])('si la cuenta del titular está %s responde 403', async (_label, ownerProfile) => {
    const { guard } = buildGuard({
      profile: ACTIVE_CLIENT_PROFILE,
      membership: { capabilities: ['orders:read'] },
      ownerProfile,
    });
    const { context } = makeContext(withHeader(OWNER_ID));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

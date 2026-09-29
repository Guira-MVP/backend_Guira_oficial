import { AccountMembersService } from './account-members.service';

/**
 * Cómo se presenta la cuenta que invita (Mi equipo). Desde el registro KYB el
 * perfil guarda la razón social: el selector de cuentas y el correo de
 * invitación la muestran en vez del nombre del titular. Sin razón social
 * (cuenta personal o anterior al registro KYB) sigue el nombre como antes.
 */

type Row = Record<string, unknown>;

function mockSupabase(tables: Record<string, Row[] | Row | null>) {
  return {
    from(table: string) {
      const value = tables[table];
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        in: () => b,
        maybeSingle: () =>
          Promise.resolve({
            data: Array.isArray(value) ? value[0] : value,
            error: null,
          }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: Array.isArray(value) ? value : value ? [value] : [],
            error: null,
          }),
      });
      return b;
    },
  };
}

function service(supabase: unknown) {
  return new AccountMembersService(
    supabase as never,
    { get: () => '' } as never,
    {} as never,
    {} as never,
  );
}

describe('AccountMembersService — nombre de la cuenta que invita', () => {
  it('el selector de cuentas muestra la razón social si existe', async () => {
    const supabase = mockSupabase({
      account_members: [
        { owner_id: 'o1', preset: 'finance', capabilities: ['orders:read'] },
        { owner_id: 'o2', preset: 'finance', capabilities: ['orders:read'] },
      ],
      profiles: [
        {
          id: 'o1',
          full_name: 'María Pérez',
          company_name: 'Importadora Andina S.R.L.',
        },
        { id: 'o2', full_name: 'Juan Rojas', company_name: null },
      ],
    });

    const accounts = await service(supabase).myLinkedAccounts('member-1');
    const byOwner = Object.fromEntries(
      accounts.map((a) => [a.owner_id, a.company_name]),
    );
    expect(byOwner.o1).toBe('Importadora Andina S.R.L.');
    // Sin razón social: el nombre del titular, como antes.
    expect(byOwner.o2).toBe('Juan Rojas');
  });

  it('el correo de invitación usa la razón social del titular', async () => {
    const svc = service(
      mockSupabase({ profiles: { company_name: 'Importadora Andina S.R.L.' } }),
    );
    const actor = { id: 'o1', profile: { full_name: 'María Pérez' } } as never;
    await expect(
      (
        svc as unknown as { ownerDisplayName: (a: unknown) => Promise<string> }
      ).ownerDisplayName(actor),
    ).resolves.toBe('Importadora Andina S.R.L.');
  });

  it('sin razón social, o si la consulta falla, usa el nombre del titular', async () => {
    const actor = { id: 'o1', profile: { full_name: 'María Pérez' } } as never;
    const call = (svc: AccountMembersService) =>
      (
        svc as unknown as { ownerDisplayName: (a: unknown) => Promise<string> }
      ).ownerDisplayName(actor);

    await expect(
      call(service(mockSupabase({ profiles: { company_name: '  ' } }))),
    ).resolves.toBe('María Pérez');
    const broken = {
      from: () => {
        throw new Error('boom');
      },
    };
    await expect(call(service(broken))).resolves.toBe('María Pérez');
  });
});

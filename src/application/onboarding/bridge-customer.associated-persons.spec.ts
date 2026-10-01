import { BridgeCustomerService } from './bridge-customer.service';

/**
 * Marcas de associated_persons que se envían a Bridge en un KYB.
 *
 * Antes del 2026-10-01:
 * - el representante legal llegaba siempre con is_director=true (un
 *   apoderado quedaba declarado como director);
 * - todo UBO llegaba con has_ownership=true aunque tuviera menos del 25%.
 * Ahora is_director sale de la respuesta del cliente y has_ownership del
 * porcentaje frente a ownership_threshold.
 */

type Rows = Record<string, unknown>[];

function supabaseMock(tables: Record<string, Rows>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        eq: chain,
        neq: chain,
        order: chain,
        limit: chain,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        single: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: rows, error: null }),
      });
      return builder;
    },
    storage: {
      from: () => ({
        download: async () => ({ data: null, error: new Error('sin archivo') }),
      }),
    },
  };
}

const address = {
  address1: 'Av Arce 1234',
  city: 'La Paz',
  state: 'L',
  country: 'BOL',
};
const business = { id: 'biz-1', ...address, ownership_threshold: null };

function build(
  directors: Rows,
  ubos: Rows,
  biz: Record<string, unknown> = business,
) {
  const service = new BridgeCustomerService(
    supabaseMock({
      business_directors: directors,
      business_ubos: ubos,
      documents: [],
    }) as never,
    { isConfigured: true } as never,
  );
  return (
    service as unknown as {
      buildAssociatedPersons: (
        businessId: string,
        fallbackEmail: string,
        business: Record<string, unknown>,
        userId: string,
      ) => Promise<Array<{ source: string; payload: Record<string, unknown> }>>;
    }
  ).buildAssociatedPersons('biz-1', 'empresa@test.bo', biz, 'user-1');
}

const legalRep = (extra: Record<string, unknown> = {}) => ({
  id: 'dir-1',
  first_name: 'Marta',
  last_name: 'Rojas',
  position: 'Gerente General',
  is_signer: true,
  ...address,
  ...extra,
});

const ubo = (extra: Record<string, unknown>) => ({
  id: `ubo-${extra.first_name as string}`,
  last_name: 'Socio',
  has_control: false,
  ...address,
  ...extra,
});

describe('BridgeCustomerService.buildAssociatedPersons — marcas de rol', () => {
  it('representante legal apoderado (is_director=false) no se declara director', async () => {
    const [rep] = await build([legalRep({ is_director: false })], []);
    expect(rep.payload.is_director).toBe(false);
    expect(rep.payload.has_control).toBe(true);
    expect(rep.payload.is_signer).toBe(true);
  });

  it('representante legal director (is_director=true) se declara director', async () => {
    const [rep] = await build([legalRep({ is_director: true })], []);
    expect(rep.payload.is_director).toBe(true);
  });

  it('representante legal anterior a la pregunta (NULL) conserva el comportamiento previo', async () => {
    const [rep] = await build([legalRep({ is_director: null })], []);
    expect(rep.payload.is_director).toBe(true);
  });

  it('has_ownership refleja el umbral del 25%', async () => {
    const persons = await build(
      [legalRep({ is_director: false })],
      [
        ubo({ first_name: 'Ana', ownership_percent: 60, is_director: true }),
        ubo({ first_name: 'Luis', ownership_percent: 10 }),
      ],
    );
    const ana = persons.find((p) => p.payload.first_name === 'Ana');
    const luis = persons.find((p) => p.payload.first_name === 'Luis');
    expect(ana?.payload.has_ownership).toBe(true);
    expect(ana?.payload.is_director).toBe(true);
    expect(luis?.payload.has_ownership).toBe(false);
    expect(luis?.payload.ownership_percentage).toBe(10);
  });

  it('respeta un ownership_threshold menor declarado por la empresa', async () => {
    const persons = await build(
      [legalRep({ is_director: false })],
      [ubo({ first_name: 'Luis', ownership_percent: 10 })],
      { ...business, ownership_threshold: 10 },
    );
    expect(
      persons.find((p) => p.payload.first_name === 'Luis')?.payload
        .has_ownership,
    ).toBe(true);
  });

  it('representante que también es socio: se fusiona y usa su respuesta de director', async () => {
    const persons = await build(
      [legalRep({ is_director: false })],
      [
        ubo({
          first_name: 'Marta',
          ownership_percent: 100,
          director_id: 'dir-1',
          has_control: true,
          position: 'Gerente General',
        }),
      ],
    );
    expect(persons).toHaveLength(1);
    expect(persons[0].payload.has_ownership).toBe(true);
    expect(persons[0].payload.is_director).toBe(false);
    expect(persons[0].payload.ownership_percentage).toBe(100);
  });
});

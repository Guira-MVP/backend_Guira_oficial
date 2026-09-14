import { HttpException } from '@nestjs/common';
import {
  INVITE_THROTTLE_OWNER_ACTION,
  INVITE_THROTTLE_RECIPIENT_ACTION,
  InvitationThrottleService,
} from './invitation-throttle.service';

/**
 * Pruebas de los límites de envío de invitaciones.
 *
 * Lo que está en juego no es la disponibilidad del backend —el throttler
 * global ya topa las peticiones— sino la reputación del dominio de envío:
 * si el remitente transaccional se usa para blasts, los proveedores lo
 * marcan y dejan de llegar los correos de recuperación de contraseña a
 * TODOS los clientes.
 *
 * El diseño anterior era un cooldown por fila, y no bastaba: con 20 filas
 * vivas daban 20 correos por minuto por cuenta, y cancelando invitaciones
 * se podían ir rotando destinatarios sin límite.
 */

const OWNER = 'owner-uuid';
const RECIPIENT = 'Contador@Empresa.com';

/**
 * Supabase simulado sobre un mapa en memoria, con la forma encadenada que
 * usa el servicio. Guarda las filas por (identifier, identifier_type,
 * action) para poder comprobar que los dos cubos se cuentan por separado.
 */
function mockSupabase() {
  const rows: Array<Record<string, any>> = [];
  let idSeq = 0;

  const api = {
    rows,
    from() {
      let filters: Record<string, unknown> = {};

      const builder: Record<string, any> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => {
          const found = rows.find((row) =>
            Object.entries(filters).every(([key, value]) => row[key] === value),
          );
          return Promise.resolve({ data: found ?? null, error: null });
        },
        insert: (payload: Record<string, any>) => {
          rows.push({ id: `row-${++idSeq}`, ...payload });
          return Promise.resolve({ data: null, error: null });
        },
        update: (payload: Record<string, any>) => {
          filters = {};
          const updateBuilder = {
            eq: (column: string, value: unknown) => {
              const target = rows.find((row) => row[column] === value);
              if (target) Object.assign(target, payload);
              return Promise.resolve({ data: null, error: null });
            },
          };
          return updateBuilder;
        },
      };

      return builder;
    },
  };

  return api;
}

function buildService(supabase: unknown) {
  return new InvitationThrottleService(supabase as never);
}

describe('InvitationThrottleService', () => {
  it('deja pasar los primeros envíos', async () => {
    const supabase = mockSupabase();
    const service = buildService(supabase);

    await expect(service.consume(OWNER, RECIPIENT)).resolves.toBeUndefined();
  });

  it('cuenta dos cubos por envío: cuenta y destinatario', async () => {
    const supabase = mockSupabase();
    const service = buildService(supabase);

    await service.consume(OWNER, RECIPIENT);

    const actions = supabase.rows.map((row) => row.action);
    expect(actions).toContain(INVITE_THROTTLE_OWNER_ACTION);
    expect(actions).toContain(INVITE_THROTTLE_RECIPIENT_ACTION);
  });

  it('normaliza el correo del destinatario a minúsculas', async () => {
    // Si no, MAYUS@x.com y mayus@x.com serían cubos distintos y el tope por
    // destinatario se esquivaría cambiando la caja de las letras.
    const supabase = mockSupabase();
    const service = buildService(supabase);

    await service.consume(OWNER, '  Contador@Empresa.com  ');

    const recipientRow = supabase.rows.find(
      (row) => row.action === INVITE_THROTTLE_RECIPIENT_ACTION,
    );
    expect(recipientRow?.identifier).toBe('contador@empresa.com');
  });

  it('corta al destinatario al cuarto envío en la misma hora', async () => {
    // Tres invitaciones al mismo buzón es de sobra; la cuarta es acoso.
    const supabase = mockSupabase();
    const service = buildService(supabase);

    await service.consume(OWNER, RECIPIENT);
    await service.consume(OWNER, RECIPIENT);
    await service.consume(OWNER, RECIPIENT);

    await expect(service.consume(OWNER, RECIPIENT)).rejects.toThrow(
      HttpException,
    );
  });

  it('corta a la cuenta al undécimo envío, aunque cambie de destinatario', async () => {
    // El agujero del diseño anterior: rotar direcciones esquivaba el límite
    // por completo.
    const supabase = mockSupabase();
    const service = buildService(supabase);

    for (let i = 0; i < 10; i++) {
      await service.consume(OWNER, `persona${i}@empresa.com`);
    }

    await expect(
      service.consume(OWNER, 'persona-11@empresa.com'),
    ).rejects.toThrow(HttpException);
  });

  it('el bloqueo de una cuenta no afecta a otra', async () => {
    const supabase = mockSupabase();
    const service = buildService(supabase);

    for (let i = 0; i < 10; i++) {
      await service.consume(OWNER, `persona${i}@empresa.com`);
    }
    await expect(service.consume(OWNER, 'otra@empresa.com')).rejects.toThrow();

    await expect(
      service.consume('otro-owner', 'alguien@empresa.com'),
    ).resolves.toBeUndefined();
  });

  it('responde 429 con los minutos que faltan', async () => {
    const supabase = mockSupabase();
    const service = buildService(supabase);

    for (let i = 0; i < 3; i++) await service.consume(OWNER, RECIPIENT);

    try {
      await service.consume(OWNER, RECIPIENT);
      fail('Debería haber lanzado');
    } catch (err) {
      const response = (err as HttpException).getResponse() as Record<
        string,
        unknown
      >;
      expect((err as HttpException).getStatus()).toBe(429);
      expect(response.retryAfter).toBeGreaterThan(0);
    }
  });

  it('falla ABIERTO si la tabla de límites no responde', async () => {
    // Este control protege la reputación del dominio, no el acceso a datos.
    // Dejar a un cliente sin poder invitar porque la tabla falló sería peor
    // que permitir un envío de más, y el throttler global sigue en pie.
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () =>
                      Promise.resolve({
                        data: null,
                        error: { message: 'timeout' },
                      }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };

    const service = buildService(supabase);
    await expect(service.consume(OWNER, RECIPIENT)).resolves.toBeUndefined();
  });
});

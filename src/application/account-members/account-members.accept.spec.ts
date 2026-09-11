import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AccountMembersService } from './account-members.service';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';

/**
 * Prueba directa de `accept()` — en particular, la pregunta que motivó
 * este archivo: si alguien recibe la invitación en un correo y se
 * registra/inicia sesión con OTRO correo distinto, ¿de verdad se le
 * niega el acceso?
 *
 * No basta con leer el código para responder esto — es exactamente el
 * tipo de verificación que en esta misma tarea encontró bugs reales que
 * la lectura no detectaba. Se ejercita el método contra un cliente de
 * Supabase simulado, con las respuestas encadenadas en el mismo orden en
 * que `accept()` las consulta.
 */
describe('AccountMembersService.accept — validación de correo', () => {
  function buildRow(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: 'row-1',
      owner_id: 'owner-1',
      member_id: null,
      invited_email: 'invitado@empresa.com',
      full_name: 'Invitado',
      preset: 'finance',
      capabilities: ['orders:read'],
      status: 'pending',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      ...overrides,
    };
  }

  function actorWithEmail(email: string): AuthenticatedUser {
    return {
      id: 'actor-1',
      email,
      profile: {
        role: 'client',
        onboarding_status: 'approved',
        is_active: true,
        is_frozen: false,
        frozen_reason: null,
        bridge_customer_id: null,
        full_name: 'Actor',
      },
      linkedAccess: null,
    };
  }

  /**
   * Cliente Supabase simulado: cada llamada a `maybeSingle()` consume la
   * siguiente respuesta de la cola, en el mismo orden en que `accept()`
   * las pide. El resto de métodos son encadenables (devuelven `this`).
   */
  function mockSupabase(responses: Array<{ data: any; error: any }>) {
    let call = 0;
    const builder: any = {
      from: jest.fn(() => builder),
      select: jest.fn(() => builder),
      eq: jest.fn(() => builder),
      update: jest.fn(() => builder),
      // audit() hace `.from('audit_logs').insert({...})` sin encadenar
      // nada más — no consume la cola de respuestas.
      insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
      maybeSingle: jest.fn(() =>
        Promise.resolve(responses[call++] ?? { data: null, error: null }),
      ),
    };
    return builder;
  }

  function buildService(supabase: any): AccountMembersService {
    return new AccountMembersService(
      supabase,
      { get: () => undefined } as any,
      {} as any, // emailService — no se usa en accept()
    );
  }

  it('RECHAZA si el correo de la cuenta que acepta no coincide con el invitado', async () => {
    const supabase = mockSupabase([{ data: buildRow(), error: null }]);
    const service = buildService(supabase);

    await expect(
      service.accept(actorWithEmail('otro@distinto.com'), 'token-123'),
    ).rejects.toThrow(ForbiddenException);

    // Ni siquiera debe llegar a intentar activar el vínculo.
    expect(supabase.update).not.toHaveBeenCalled();
  });

  it('el rechazo por correo no revela nada del contenido de la invitación', async () => {
    const supabase = mockSupabase([{ data: buildRow(), error: null }]);
    const service = buildService(supabase);

    try {
      await service.accept(actorWithEmail('otro@distinto.com'), 'token-123');
      fail('debería haber lanzado ForbiddenException');
    } catch (err) {
      const message = (err as ForbiddenException).message;
      expect(message).not.toContain('invitado@empresa.com');
      expect(message).not.toContain('owner-1');
    }
  });

  it('ACEPTA cuando el correo coincide, sin importar mayúsculas ni espacios', async () => {
    const supabase = mockSupabase([
      { data: buildRow({ invited_email: '  Ana@Empresa.com  ' }), error: null },
      { data: null, error: null }, // no tiene ya un vínculo activo
      { data: buildRow({ status: 'active' }), error: null }, // update final
    ]);
    const service = buildService(supabase);

    await expect(
      service.accept(actorWithEmail('ana@empresa.com'), 'token-123'),
    ).resolves.toMatchObject({ status: 'active' });
  });

  it('el reenvío del enlace a un tercero no le sirve de nada', async () => {
    // Escenario del diseño (§3.3 del plan): alguien reenvía el correo con
    // el token a un tercero. El token es válido —es el mismo token—, pero
    // el tercero inicia sesión con SU propio correo, que nunca coincide.
    const supabase = mockSupabase([
      { data: buildRow({ invited_email: 'destinatario.real@empresa.com' }), error: null },
    ]);
    const service = buildService(supabase);

    await expect(
      service.accept(actorWithEmail('tercero.ajeno@otraempresa.com'), 'token-robado'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('invitación inexistente o ya usada → NotFoundException', async () => {
    const supabase = mockSupabase([{ data: null, error: null }]);
    const service = buildService(supabase);

    await expect(service.accept(actorWithEmail('x@x.com'), 'token')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('invitación ya activa (reutilizada) → NotFoundException, no se revalida el correo', async () => {
    const supabase = mockSupabase([
      { data: buildRow({ status: 'active' }), error: null },
    ]);
    const service = buildService(supabase);

    // No debe llegar ni a comparar el correo: el estado ya descarta la fila.
    await expect(
      service.accept(actorWithEmail('cualquiera@x.com'), 'token'),
    ).rejects.toThrow(NotFoundException);
  });

  it('invitación caducada → BadRequestException y la marca como expirada', async () => {
    const supabase = mockSupabase([
      { data: buildRow({ expires_at: new Date(Date.now() - 1000).toISOString() }), error: null },
    ]);
    const service = buildService(supabase);

    await expect(
      service.accept(actorWithEmail('invitado@empresa.com'), 'token'),
    ).rejects.toThrow(BadRequestException);

    expect(supabase.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    );
  });

  it('ya tiene acceso activo a esa cuenta → BadRequestException con mensaje claro', async () => {
    const supabase = mockSupabase([
      { data: buildRow(), error: null },
      { data: { id: 'existing-row' }, error: null }, // ya hay vínculo activo
    ]);
    const service = buildService(supabase);

    await expect(
      service.accept(actorWithEmail('invitado@empresa.com'), 'token'),
    ).rejects.toThrow(BadRequestException);
  });

  it('doble clic (carrera de aceptación) → mensaje claro, no un 500', async () => {
    const supabase = mockSupabase([
      { data: buildRow(), error: null },
      { data: null, error: null }, // sin vínculo previo
      { data: null, error: null }, // el UPDATE no afecta filas: otra petición ya ganó
    ]);
    const service = buildService(supabase);

    await expect(
      service.accept(actorWithEmail('invitado@empresa.com'), 'token'),
    ).rejects.toThrow(BadRequestException);
  });
});

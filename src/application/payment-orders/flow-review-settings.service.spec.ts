import { NotFoundException } from '@nestjs/common';
import { FlowReviewSettingsService } from './flow-review-settings.service';

/**
 * Tests del switch por flujo de la puerta de revisión de staff.
 *
 * Lo que se protege aquí:
 *   1. Ante cualquier duda (tabla caída, flujo sin fila) se REVISA. Dejar salir
 *      dinero sin revisar por un fallo de configuración es el peor resultado.
 *   2. Un flujo sin ejecutor no pasa por la puerta aunque alguien inserte una
 *      fila para él: sin tramo que ejecutar, el expediente quedaría atascado.
 *   3. Guardar invalida la caché, para que apagar el switch por una incidencia
 *      surta efecto de inmediato.
 */
describe('FlowReviewSettingsService', () => {
  function makeSupabase(rows: any[] | null, opts: { selectError?: unknown } = {}) {
    const inserts: any[] = [];
    let updatePayload: any = null;

    const from = jest.fn((table: string) => {
      const query: any = {
        __isUpdate: false,
        select: jest.fn(() => query),
        order: jest.fn(async () => ({ data: rows, error: null })),
        insert: jest.fn((payload: unknown) => {
          inserts.push({ table, payload });
          return Promise.resolve({ data: null, error: null });
        }),
        update: jest.fn((payload: unknown) => {
          query.__isUpdate = true;
          updatePayload = payload;
          return query;
        }),
        eq: jest.fn(() => query),
        maybeSingle: jest.fn(async () => ({
          data: rows?.[0] ? { ...rows[0], ...updatePayload } : null,
          error: null,
        })),
        // El await directo sobre .select() (sin .order) es la carga de caché.
        then: (resolve: any) =>
          resolve(
            opts.selectError
              ? { data: null, error: opts.selectError }
              : { data: rows, error: null },
          ),
      };
      return query;
    });

    return { from, __inserts: inserts };
  }

  const ROWS = [
    { flow_type: 'bolivia_to_world', requires_staff_review: true },
    { flow_type: 'wallet_to_world', requires_staff_review: false },
  ];

  it('respeta el switch de cada flujo', async () => {
    const service = new FlowReviewSettingsService(makeSupabase(ROWS) as any);

    await expect(service.requiresReview('bolivia_to_world')).resolves.toBe(true);
    await expect(service.requiresReview('wallet_to_world')).resolves.toBe(false);
  });

  it('un flujo sin fila configurada se revisa: el default seguro es revisar', async () => {
    const service = new FlowReviewSettingsService(makeSupabase(ROWS) as any);

    await expect(service.requiresReview('bridge_wallet_to_crypto')).resolves.toBe(
      true,
    );
  });

  it('si la tabla no responde, se revisa igualmente', async () => {
    // Preferimos una cola llena a dejar salir dinero sin revisar por un fallo
    // de infraestructura.
    const service = new FlowReviewSettingsService(
      makeSupabase(null, { selectError: new Error('conexión caída') }) as any,
    );

    await expect(service.requiresReview('bolivia_to_world')).resolves.toBe(true);
  });

  it('va_deposit nunca pasa por la puerta, tenga fila o no', async () => {
    // Lo dispara un webhook de Bridge cuando llega dinero a una cuenta virtual:
    // no hay nada que revisar antes de que ocurra, y no existe ejecutor.
    const service = new FlowReviewSettingsService(
      makeSupabase([
        { flow_type: 'va_deposit', requires_staff_review: true },
      ]) as any,
    );

    await expect(service.requiresReview('va_deposit')).resolves.toBe(false);
    await expect(service.requiresReview(null)).resolves.toBe(false);
    await expect(service.requiresReview(undefined)).resolves.toBe(false);
  });

  it('cachea entre llamadas para no consultar en cada creación de expediente', async () => {
    const supabase = makeSupabase(ROWS);
    const service = new FlowReviewSettingsService(supabase as any);

    await service.requiresReview('bolivia_to_world');
    await service.requiresReview('bolivia_to_world');
    await service.requiresReview('wallet_to_world');

    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it('guardar invalida la caché para que el cambio surta efecto de inmediato', async () => {
    const supabase = makeSupabase(ROWS);
    const service = new FlowReviewSettingsService(supabase as any);

    await service.requiresReview('bolivia_to_world');
    const callsAfterFirstRead = supabase.from.mock.calls.length;

    await service.updateSetting('bolivia_to_world', false, 'admin-1', 'admin');
    await service.requiresReview('bolivia_to_world');

    expect(supabase.from.mock.calls.length).toBeGreaterThan(callsAfterFirstRead);
  });

  it('guardar deja rastro en auditoría', async () => {
    const supabase = makeSupabase(ROWS);
    const service = new FlowReviewSettingsService(supabase as any);

    await service.updateSetting('bolivia_to_world', false, 'admin-1', 'admin');

    const audit = supabase.__inserts.find((i) => i.table === 'audit_logs');
    expect(audit?.payload).toMatchObject({
      action: 'DISABLE_FLOW_STAFF_REVIEW',
      record_id: 'bolivia_to_world',
      performed_by: 'admin-1',
      previous_values: { requires_staff_review: true },
      new_values: { requires_staff_review: false },
    });
  });

  it('404 si el flujo no existe en la configuración', async () => {
    const service = new FlowReviewSettingsService(makeSupabase(null) as any);

    await expect(
      service.updateSetting('flujo_inventado', true, 'admin-1', 'admin'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

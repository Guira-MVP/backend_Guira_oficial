import { DiditWalletRescreeningService } from './didit-wallet-rescreening.service';
import { WalletScreeningVerdict } from './didit.types';

/**
 * Pruebas del barrido periódico de direcciones cripto ya registradas.
 *
 * Lo que se protege aquí es la política acordada, que es asimétrica a
 * propósito: las SANCIONES bloquean solas (obligación legal), mientras que el
 * riesgo crítico sin sanciones solo se marca para que compliance decida —
 * bloquear por exposición indirecta rompería operaciones legítimas sin que
 * nadie lo mire. Y ningún fallo del proveedor puede bloquear a nadie.
 */

interface MockOptions {
  settings?: Record<string, string>;
  settingsError?: string;
  claimed?: Array<Record<string, unknown>>;
  claimError?: string;
  inFlightOrderIds?: string[];
  staffIds?: string[];
}

function mockSupabase(opts: MockOptions) {
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];

  const resultFor = (table: string): { data: unknown; error: unknown } => {
    switch (table) {
      case 'app_settings':
        return opts.settingsError
          ? { data: null, error: { message: opts.settingsError } }
          : {
              data: Object.entries(opts.settings ?? {}).map(([key, value]) => ({
                key,
                value,
              })),
              error: null,
            };
      case 'payment_orders':
        return {
          data: (opts.inFlightOrderIds ?? []).map((id) => ({ id })),
          error: null,
        };
      case 'profiles':
        return {
          data: (opts.staffIds ?? []).map((id) => ({ id })),
          error: null,
        };
      default:
        return { data: [], error: null };
    }
  };

  function builder(table: string) {
    const b: any = {
      select: () => b,
      eq: () => b,
      in: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      update: (payload: Record<string, unknown>) => {
        updates.push({ table, payload });
        return b;
      },
      insert: (payload: unknown) => {
        inserts.push({ table, payload });
        return Promise.resolve({ data: null, error: null });
      },
      single: () => Promise.resolve(resultFor(table)),
      maybeSingle: () => Promise.resolve(resultFor(table)),
      // Thenable: así cualquier longitud de cadena resuelve sin tener que
      // saber en qué método termina cada consulta.
      then: (resolve: (v: unknown) => unknown) => resolve(resultFor(table)),
    };
    return b;
  }

  const supabase: any = {
    from: jest.fn((table: string) => builder(table)),
    rpc: jest.fn((name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve(
        opts.claimError
          ? { data: null, error: { message: opts.claimError } }
          : { data: opts.claimed ?? [], error: null },
      );
    }),
  };

  return { supabase, updates, inserts, rpcCalls };
}

const ENABLED_SETTINGS = {
  WALLET_RESCREENING_ENABLED: 'true',
  WALLET_RESCREENING_INTERVAL_DAYS: '30',
  WALLET_RESCREENING_BATCH_SIZE: '25',
};

function supplierRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sup-1',
    user_id: 'user-1',
    name: 'Industrias Albus',
    bridge_liquidation_address_id: 'la-1',
    bank_details: {
      wallet_address: '4KSoLZYNSnUJU189YfUGHvP9A9rKXdjL2qPVrvDdthTL',
      wallet_network: 'solana',
      wallet_currency: 'usdc',
      wallet_screening: {
        schema_version: 1,
        status: 'Approved',
        decision: 'allow',
        screened_at: '2026-08-01T00:00:00.000Z',
        risk_score: 0,
        severity: 'UNKNOWN',
        sanctions_hit: false,
        rescreen_claimed_at: '2026-09-16T19:00:00.000Z',
      },
    },
    ...overrides,
  };
}

function verdict(overrides: Partial<WalletScreeningVerdict> = {}): WalletScreeningVerdict {
  return {
    schema_version: 1,
    status: 'Approved',
    decision: 'allow',
    screened_at: new Date().toISOString(),
    provider: 'merklescience',
    blockchain: 'SOL',
    risk_score: 0,
    severity: 'UNKNOWN',
    sanctions_hit: false,
    dominant_risk_category: null,
    risk_factors: [],
    ...overrides,
  };
}

function mockScreening(result: WalletScreeningVerdict) {
  return { screenBeneficiaryWallet: jest.fn().mockResolvedValue(result) } as any;
}

function mockNotifications() {
  return { sendNotification: jest.fn() } as any;
}

describe('DiditWalletRescreeningService', () => {
  describe('interruptor', () => {
    it('apagado: no reclama nada ni llama a Didit', async () => {
      const { supabase, rpcCalls } = mockSupabase({
        settings: { WALLET_RESCREENING_ENABLED: 'false' },
      });
      const screening = mockScreening(verdict());
      const service = new DiditWalletRescreeningService(
        supabase,
        screening,
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      expect(rpcCalls).toHaveLength(0);
      expect(screening.screenBeneficiaryWallet).not.toHaveBeenCalled();
    });

    it('sin las claves en app_settings está apagado por defecto', async () => {
      // Defensa del despliegue: hasta que alguien cree y active la clave, el
      // barrido no existe.
      const { supabase, rpcCalls } = mockSupabase({ settings: {} });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(verdict()),
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      expect(rpcCalls).toHaveLength(0);
    });

    it('si falla la lectura de configuración no barre', async () => {
      const { supabase, rpcCalls } = mockSupabase({
        settingsError: 'connection reset',
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(verdict()),
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      expect(rpcCalls).toHaveLength(0);
    });
  });

  describe('configuración', () => {
    it('pasa intervalo y tamaño de lote a la RPC', async () => {
      const { supabase, rpcCalls } = mockSupabase({
        settings: {
          WALLET_RESCREENING_ENABLED: 'true',
          WALLET_RESCREENING_INTERVAL_DAYS: '7',
          WALLET_RESCREENING_BATCH_SIZE: '5',
        },
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(verdict()),
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      expect(rpcCalls[0]).toEqual({
        name: 'claim_suppliers_for_rescreening',
        args: { p_interval_days: 7, p_batch_size: 5 },
      });
    });

    it('un valor basura cae al default en vez de barrer con intervalo 0', async () => {
      // Un typo en el panel no debe provocar un barrido de la cartera entera.
      const { supabase, rpcCalls } = mockSupabase({
        settings: {
          WALLET_RESCREENING_ENABLED: 'true',
          WALLET_RESCREENING_INTERVAL_DAYS: 'treinta',
          WALLET_RESCREENING_BATCH_SIZE: '-5',
        },
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(verdict()),
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      expect(rpcCalls[0].args).toEqual({
        p_interval_days: 30,
        p_batch_size: 25,
      });
    });

    it('acepta intervalo 0 (barrido inmediato, para probar en staging)', async () => {
      const { supabase, rpcCalls } = mockSupabase({
        settings: { ...ENABLED_SETTINGS, WALLET_RESCREENING_INTERVAL_DAYS: '0' },
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(verdict()),
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      expect((rpcCalls[0].args as any).p_interval_days).toBe(0);
    });
  });

  describe('aplicación del veredicto', () => {
    it('dirección limpia: no marca nada ni notifica', async () => {
      const notifications = mockNotifications();
      const { supabase, updates, inserts } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimed: [supplierRow()],
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(verdict()),
        notifications,
      );

      await service.rescreenDueWallets();

      const supplierUpdate = updates.find((u) => u.table === 'suppliers');
      expect(supplierUpdate).toBeDefined();
      expect(supplierUpdate!.payload.compliance_status).toBeUndefined();
      expect(notifications.sendNotification).not.toHaveBeenCalled();
      expect(inserts.find((i) => i.table === 'notifications')).toBeUndefined();
    });

    it('SANCIONES: bloquea, avisa al cliente y mata la liquidation address', async () => {
      const notifications = mockNotifications();
      const { supabase, updates, inserts } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimed: [supplierRow()],
        staffIds: ['staff-1', 'staff-2'],
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(
          verdict({
            status: 'Declined',
            decision: 'block',
            sanctions_hit: true,
            risk_score: 95,
            severity: 'CRITICAL',
            dominant_risk_category: 'sanctioned',
          }),
        ),
        notifications,
      );

      await service.rescreenDueWallets();

      const supplierUpdate = updates.find((u) => u.table === 'suppliers');
      expect(supplierUpdate!.payload.compliance_status).toBe('blocked');
      expect(supplierUpdate!.payload.compliance_reason).toContain('Sanciones');

      // Defensa en profundidad: el riel de pago real queda desactivado.
      const laUpdate = updates.find(
        (u) => u.table === 'bridge_liquidation_addresses',
      );
      expect(laUpdate!.payload).toEqual({ is_active: false });

      expect(notifications.sendNotification).toHaveBeenCalledTimes(1);
      const notified = notifications.sendNotification.mock.calls[0][0];
      expect(notified.userId).toBe('user-1');
      expect(notified.referenceId).toBe('sup-1');

      // Audit trail y aviso al staff (un insert con las dos filas de staff).
      expect(
        inserts.find(
          (i) =>
            i.table === 'audit_logs' &&
            (i.payload as any).action === 'SUPPLIER_COMPLIANCE_BLOCKED',
        ),
      ).toBeDefined();
      const staffNotif = inserts.find((i) => i.table === 'notifications');
      expect(staffNotif).toBeDefined();
      expect(staffNotif!.payload as unknown[]).toHaveLength(2);
    });

    it('el aviso al cliente no filtra el proveedor, el score ni las categorías', async () => {
      // El texto va al cliente: señala la dirección, no a él, y la telemetría
      // de compliance se queda en el panel del staff.
      const notifications = mockNotifications();
      const { supabase } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimed: [supplierRow()],
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(
          verdict({
            status: 'Declined',
            sanctions_hit: true,
            risk_score: 95,
            dominant_risk_category: 'mixer',
          }),
        ),
        notifications,
      );

      await service.rescreenDueWallets();

      const { message, title } =
        notifications.sendNotification.mock.calls[0][0];
      expect(message).not.toMatch(/merklescience/i);
      expect(message).not.toMatch(/95/);
      expect(message).not.toMatch(/mixer/i);
      // Y acota el daño explícitamente, para que no parezca un cierre de cuenta.
      expect(message).toMatch(/tu cuenta no están afectados/i);
      expect(title).toMatch(/cumplimiento/i);
    });

    it('CRITICAL sin sanciones: marca para revisión, NO bloquea ni avisa al cliente', async () => {
      const notifications = mockNotifications();
      const { supabase, updates, inserts } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimed: [supplierRow()],
        staffIds: ['staff-1'],
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(
          verdict({
            status: 'Declined',
            decision: 'block',
            sanctions_hit: false,
            severity: 'CRITICAL',
            risk_score: 92,
          }),
        ),
        notifications,
      );

      await service.rescreenDueWallets();

      const supplierUpdate = updates.find((u) => u.table === 'suppliers');
      expect(supplierUpdate!.payload.compliance_status).toBe('pending_review');

      // No se toca la liquidation address: el beneficiario sigue operativo.
      expect(
        updates.find((u) => u.table === 'bridge_liquidation_addresses'),
      ).toBeUndefined();

      // Al cliente no se le dice nada de un hallazgo sin confirmar.
      expect(notifications.sendNotification).not.toHaveBeenCalled();

      // Pero el staff sí se entera, y con el aviso de que NO está bloqueado.
      const staffNotif = inserts.find((i) => i.table === 'notifications');
      expect((staffNotif!.payload as any[])[0].message).toMatch(
        /NO fue bloqueado/,
      );
    });

    it('no reutiliza verdict.decision: sanciones y CRITICAL dan estados distintos', async () => {
      // Ambos llegan con decision 'block' desde el servicio de screening; el
      // re-screening tiene que separarlos.
      const run = async (over: Partial<WalletScreeningVerdict>) => {
        const { supabase, updates } = mockSupabase({
          settings: ENABLED_SETTINGS,
          claimed: [supplierRow()],
        });
        const service = new DiditWalletRescreeningService(
          supabase,
          mockScreening(verdict({ status: 'Declined', decision: 'block', ...over })),
          mockNotifications(),
        );
        await service.rescreenDueWallets();
        return updates.find((u) => u.table === 'suppliers')!.payload
          .compliance_status;
      };

      expect(await run({ sanctions_hit: true, severity: 'CRITICAL' })).toBe(
        'blocked',
      );
      expect(await run({ sanctions_hit: false, severity: 'CRITICAL' })).toBe(
        'pending_review',
      );
    });

    it('HIGH y MEDIUM actualizan el veredicto sin marcar el beneficiario', async () => {
      for (const severity of ['HIGH', 'MEDIUM'] as const) {
        const notifications = mockNotifications();
        const { supabase, updates } = mockSupabase({
          settings: ENABLED_SETTINGS,
          claimed: [supplierRow()],
        });
        const service = new DiditWalletRescreeningService(
          supabase,
          mockScreening(verdict({ status: 'In Review', decision: 'flag', severity })),
          notifications,
        );

        await service.rescreenDueWallets();

        const payload = updates.find((u) => u.table === 'suppliers')!.payload;
        expect(payload.compliance_status).toBeUndefined();
        expect(payload.bank_details).toBeDefined();
        expect(notifications.sendNotification).not.toHaveBeenCalled();
      }
    });

    it('un fallo del proveedor nunca bloquea a nadie', async () => {
      for (const status of ['Error', 'Skipped'] as const) {
        const notifications = mockNotifications();
        const { supabase, updates } = mockSupabase({
          settings: ENABLED_SETTINGS,
          claimed: [supplierRow()],
        });
        const service = new DiditWalletRescreeningService(
          supabase,
          // Peor caso: el proveedor falla pero devuelve sanctions_hit true.
          // Sin resultado válido no hay nada que aplicar.
          mockScreening(verdict({ status, sanctions_hit: true })),
          notifications,
        );

        await service.rescreenDueWallets();

        const payload = updates.find((u) => u.table === 'suppliers')!.payload;
        expect(payload.compliance_status).toBeUndefined();
        expect(notifications.sendNotification).not.toHaveBeenCalled();
      }
    });
  });

  describe('persistencia', () => {
    it('conserva el veredicto anterior y le quita el sello del reclamo', async () => {
      const { supabase, updates } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimed: [supplierRow()],
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(verdict({ risk_score: 12, severity: 'LOW' })),
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      const bankDetails = updates.find((u) => u.table === 'suppliers')!.payload
        .bank_details as Record<string, any>;

      expect(bankDetails.wallet_screening.risk_score).toBe(12);
      expect(bankDetails.wallet_screening_previous.screened_at).toBe(
        '2026-08-01T00:00:00.000Z',
      );
      // El sello del reclamo es un detalle interno del cron: en el veredicto
      // archivado solo sería ruido.
      expect(
        bankDetails.wallet_screening_previous.rescreen_claimed_at,
      ).toBeUndefined();
      // Y no se pierde el resto de bank_details.
      expect(bankDetails.wallet_address).toBeDefined();
      expect(bankDetails.wallet_network).toBe('solana');
    });

    it('un beneficiario sin veredicto previo no crea wallet_screening_previous', async () => {
      const row = supplierRow();
      delete (row.bank_details as any).wallet_screening;

      const { supabase, updates } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimed: [row],
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(verdict()),
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      const bankDetails = updates.find((u) => u.table === 'suppliers')!.payload
        .bank_details as Record<string, any>;
      expect(bankDetails.wallet_screening_previous).toBeUndefined();
      expect(bankDetails.wallet_screening).toBeDefined();
    });
  });

  describe('robustez del lote', () => {
    it('un beneficiario que falla no aborta el resto del lote', async () => {
      const screening = {
        screenBeneficiaryWallet: jest
          .fn()
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValue(verdict()),
      } as any;

      const { supabase, updates } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimed: [
          supplierRow({ id: 'sup-1' }),
          supplierRow({ id: 'sup-2' }),
          supplierRow({ id: 'sup-3' }),
        ],
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        screening,
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      expect(screening.screenBeneficiaryWallet).toHaveBeenCalledTimes(3);
      // El primero falló antes de persistir; los otros dos se guardaron.
      expect(updates.filter((u) => u.table === 'suppliers')).toHaveLength(2);
    });

    it('si la RPC de reclamo falla, no se llama a Didit', async () => {
      const screening = mockScreening(verdict());
      const { supabase } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimError: 'deadlock detected',
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        screening,
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      expect(screening.screenBeneficiaryWallet).not.toHaveBeenCalled();
    });

    it('un beneficiario cripto sin dirección se omite sin tocar su estado', async () => {
      const row = supplierRow();
      delete (row.bank_details as any).wallet_address;

      const screening = mockScreening(verdict());
      const { supabase, updates } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimed: [row],
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        screening,
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      expect(screening.screenBeneficiaryWallet).not.toHaveBeenCalled();
      expect(updates.filter((u) => u.table === 'suppliers')).toHaveLength(0);
    });
  });

  describe('órdenes en curso', () => {
    it('recoge los IDs de las órdenes activas al bloquear, sin cancelarlas', async () => {
      const { supabase, updates, inserts } = mockSupabase({
        settings: ENABLED_SETTINGS,
        claimed: [supplierRow()],
        inFlightOrderIds: ['aaaaaaaa-1111-2222-3333-444444444444'],
        staffIds: ['staff-1'],
      });
      const service = new DiditWalletRescreeningService(
        supabase,
        mockScreening(verdict({ status: 'Declined', sanctions_hit: true })),
        mockNotifications(),
      );

      await service.rescreenDueWallets();

      const audit = inserts.find(
        (i) =>
          i.table === 'audit_logs' &&
          (i.payload as any).action === 'SUPPLIER_COMPLIANCE_BLOCKED',
      );
      expect((audit!.payload as any).new_values.in_flight_order_ids).toEqual([
        'aaaaaaaa-1111-2222-3333-444444444444',
      ]);

      // Las órdenes NO se cancelan: esa decisión es del staff.
      expect(updates.find((u) => u.table === 'payment_orders')).toBeUndefined();

      const staffNotif = inserts.find((i) => i.table === 'notifications');
      expect((staffNotif!.payload as any[])[0].message).toMatch(
        /1 orden\(es\) en curso/,
      );
    });
  });
});

import { BadRequestException } from '@nestjs/common';
import { SuppliersService } from './suppliers.service';

/**
 * Al cambiar la dirección (o la red) de un beneficiario cripto se screenea la
 * nueva en el momento. Antes solo se marcaba `Skipped` con fecha de hoy, y
 * como el re-screening periódico se guía por esa fecha, la dirección nueva
 * quedaba sin revisar un intervalo completo — mientras wallet_to_wallet ya le
 * pagaba directamente.
 */

const SUPPLIER_ID = 'supplier-1';
const USER_ID = 'user-1';

function existingCrypto(overrides: Record<string, unknown> = {}) {
  return {
    id: SUPPLIER_ID,
    user_id: USER_ID,
    name: 'Proveedor Cripto',
    payment_rail: 'crypto',
    contact_email: null,
    notes: null,
    bridge_external_account_id: null,
    bridge_liquidation_address_id: null,
    bank_details: {
      wallet_address: 'OLD_ADDRESS',
      wallet_network: 'solana',
      wallet_currency: 'usdc',
      wallet_screening: {
        schema_version: 1,
        status: 'Approved',
        decision: 'allow',
        screened_at: '2026-09-01T00:00:00.000Z',
        rescreen_claimed_at: '2026-09-01T00:00:00.000Z',
      },
    },
    ...overrides,
  };
}

function mockSupabase() {
  const updates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];

  const from = jest.fn((table: string) => {
    if (table === 'audit_logs') {
      return {
        insert: (payload: Record<string, unknown>) => {
          audits.push(payload);
          return Promise.resolve({ error: null });
        },
      };
    }
    if (table === 'suppliers') {
      return {
        update: (payload: Record<string, unknown>) => {
          updates.push(payload);
          const chain: any = {
            eq: () => chain,
            select: () => chain,
            single: () => Promise.resolve({ data: { id: SUPPLIER_ID, ...payload }, error: null }),
          };
          return chain;
        },
      };
    }
    throw new Error(`tabla no configurada: ${table}`);
  });

  return { from, _updates: updates, _audits: audits };
}

function verdict(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    status: 'Approved',
    decision: 'allow',
    screened_at: new Date().toISOString(),
    risk_score: 3,
    severity: 'UNKNOWN',
    sanctions_hit: false,
    ...overrides,
  };
}

function build(existing: Record<string, unknown>, screen: jest.Mock) {
  const supabase = mockSupabase();
  const service = new SuppliersService(
    supabase as any,
    {} as any,
    { screenBeneficiaryWallet: screen } as any,
    {} as any,
  );
  jest.spyOn(service, 'findOne').mockResolvedValue(existing as any);
  return { service, supabase };
}

describe('SuppliersService.update — screening de la dirección cripto', () => {
  it('screenea la dirección nueva y guarda su veredicto, conservando el anterior', async () => {
    const screen = jest.fn().mockResolvedValue(verdict());
    const { service, supabase } = build(existingCrypto(), screen);

    await service.update(SUPPLIER_ID, USER_ID, { wallet_address: 'NEW_ADDRESS' } as any);

    expect(screen).toHaveBeenCalledWith({
      walletAddress: 'NEW_ADDRESS',
      walletNetwork: 'solana',
      userId: USER_ID,
    });
    const bankDetails = supabase._updates[0].bank_details as Record<string, any>;
    expect(bankDetails.wallet_address).toBe('NEW_ADDRESS');
    expect(bankDetails.wallet_screening.status).toBe('Approved');
    expect(bankDetails.wallet_screening_previous.status).toBe('Approved');
    // El sello del reclamo del cron no se arrastra al veredicto archivado.
    expect(bankDetails.wallet_screening_previous.rescreen_claimed_at).toBeUndefined();
  });

  it('rechaza el cambio a una dirección sancionada sin escribir nada en suppliers', async () => {
    const screen = jest
      .fn()
      .mockResolvedValue(verdict({ status: 'Declined', decision: 'block', sanctions_hit: true }));
    const { service, supabase } = build(existingCrypto(), screen);

    await expect(
      service.update(SUPPLIER_ID, USER_ID, { wallet_address: 'SANCTIONED' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(supabase._updates).toHaveLength(0);
    expect(supabase._audits).toEqual([
      expect.objectContaining({
        action: 'SUPPLIER_WALLET_SCREENING_BLOCKED',
        record_id: SUPPLIER_ID,
      }),
    ]);
  });

  it('un cambio solo de red también se screenea (misma dirección, otra cadena)', async () => {
    const screen = jest.fn().mockResolvedValue(verdict());
    const { service } = build(existingCrypto(), screen);

    await service.update(SUPPLIER_ID, USER_ID, { wallet_network: 'Tron' } as any);

    expect(screen).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: 'OLD_ADDRESS', walletNetwork: 'tron' }),
    );
  });

  it('un riesgo medio/alto (flag) guarda el cambio con el veredicto, igual que al crear', async () => {
    const screen = jest
      .fn()
      .mockResolvedValue(verdict({ status: 'In Review', decision: 'flag', severity: 'HIGH' }));
    const { service, supabase } = build(existingCrypto(), screen);

    await service.update(SUPPLIER_ID, USER_ID, { wallet_address: 'RISKY' } as any);

    const bankDetails = supabase._updates[0].bank_details as Record<string, any>;
    expect(bankDetails.wallet_screening.decision).toBe('flag');
  });

  it('no llama a Didit si la dirección y la red no cambian', async () => {
    const screen = jest.fn();
    const { service } = build(existingCrypto(), screen);

    await service.update(SUPPLIER_ID, USER_ID, {
      name: 'Nuevo nombre',
      wallet_address: 'OLD_ADDRESS',
      wallet_network: 'SOLANA',
    } as any);

    expect(screen).not.toHaveBeenCalled();
  });

  it('no screenea beneficiarios que no son cripto', async () => {
    const screen = jest.fn();
    const { service } = build(
      existingCrypto({ payment_rail: 'ach', bank_details: { bank_name: 'X' } }),
      screen,
    );

    await service.update(SUPPLIER_ID, USER_ID, { bank_name: 'Y' } as any);

    expect(screen).not.toHaveBeenCalled();
  });
});

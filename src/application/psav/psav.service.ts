import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';

export enum PsavAccountType {
  BANK_BO = 'bank_bo',
  BANK_US = 'bank_us',
  CRYPTO = 'crypto',
}

@Injectable()
export class PsavService {
  private readonly logger = new Logger(PsavService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Obtiene la cuenta PSAV activa para un tipo y moneda específicos.
   * Se usa internamente al crear una orden que requiere PSAV.
   */
  async getDepositAccount(type: string, currency: string) {
    const { data, error } = await this.supabase
      .from('psav_accounts')
      .select('*')
      .eq('type', type)
      .eq('currency', currency.toUpperCase())
      .eq('is_active', true)
      .limit(1)
      .single();

    if (error || !data) {
      throw new NotFoundException(
        `No hay cuenta PSAV activa para ${type}/${currency}`,
      );
    }

    return data;
  }

  /**
   * Formatea las instrucciones de depósito que se muestran al usuario
   * según el tipo de cuenta PSAV.
   */
  formatDepositInstructions(
    account: Record<string, unknown>,
  ): Record<string, unknown> {
    if (account.type === 'crypto') {
      return {
        type: 'crypto',
        address: account.crypto_address,
        network: account.crypto_network,
        currency: account.currency,
        label: account.name,
      };
    }

    return {
      type: 'bank',
      bank_name: account.bank_name,
      account_number: account.account_number,
      routing_number: account.routing_number,
      account_holder: account.account_holder,
      qr_url: account.qr_url,
      currency: account.currency,
      label: account.name,
    };
  }

  /**
   * Obtiene todas las cuentas PSAV crypto activas.
   * Se usa para resolución dinámica del PSAV en flujos off-ramp
   * donde la divisa de destino no es fija.
   */
  async getActiveCryptoAccounts() {
    const { data, error } = await this.supabase
      .from('psav_accounts')
      .select('*')
      .eq('type', 'crypto')
      .eq('is_active', true)
      .order('currency');

    if (error) throw error;
    return data ?? [];
  }

  // ── Admin CRUD ─────────────────────────────────

  async listAccounts() {
    const { data, error } = await this.supabase
      .from('psav_accounts')
      .select('*')
      .order('type')
      .order('currency');

    if (error) throw error;
    return data ?? [];
  }

  async createAccount(dto: {
    name: string;
    type: string;
    currency: string;
    bank_name?: string;
    account_number?: string;
    routing_number?: string;
    account_holder?: string;
    qr_url?: string;
    crypto_address?: string;
    crypto_network?: string;
  }) {
    const { data, error } = await this.supabase
      .from('psav_accounts')
      .insert({
        ...dto,
        currency: dto.currency.toUpperCase(),
        is_active: true,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateAccount(
    id: string,
    dto: Partial<{
      name: string;
      type: string;
      currency: string;
      bank_name: string;
      account_number: string;
      routing_number: string;
      account_holder: string;
      qr_url: string;
      crypto_address: string;
      crypto_network: string;
      is_active: boolean;
    }>,
  ) {
    const { data, error } = await this.supabase
      .from('psav_accounts')
      .update(dto)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      throw new NotFoundException('Cuenta PSAV no encontrada');
    }

    return data;
  }

  async deactivateAccount(id: string) {
    return this.updateAccount(id, { is_active: false });
  }
}

import { Injectable, Inject, NotFoundException, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { AdminGateway } from '../admin/admin.gateway';
import type { CreatePsavDto, UpdatePsavDto } from './dto/create-psav.dto';

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
    private readonly adminGateway: AdminGateway,
  ) {}

  // ── Resolución por usuario ──────────────────────────────────────

  /**
   * Devuelve el psav_id asignado al usuario, o null si no tiene ninguno.
   */
  private async resolveUserPsavId(userId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('profiles')
      .select('assigned_psav_id')
      .eq('id', userId)
      .single();
    return data?.assigned_psav_id ?? null;
  }

  /**
   * Obtiene la cuenta PSAV activa del usuario para un tipo y moneda concretos.
   * Primero usa el PSAV asignado al usuario; si no tiene, busca globalmente
   * (comportamiento anterior — compatibilidad con clientes sin asignar).
   */
  async getDepositAccountForUser(userId: string, type: string, currency: string) {
    const psavId = await this.resolveUserPsavId(userId);
    return this.getDepositAccount(type, currency, psavId ?? undefined);
  }

  /**
   * Obtiene todas las cuentas PSAV crypto activas para el usuario.
   * Filtra por su PSAV asignado; fallback global si no tiene.
   */
  async getActiveCryptoAccountsForUser(userId: string) {
    const psavId = await this.resolveUserPsavId(userId);
    return this.getActiveCryptoAccounts(psavId ?? undefined);
  }

  // ── Acceso a canales (psav_accounts) ───────────────────────────

  /**
   * Obtiene la cuenta PSAV activa para un tipo y moneda.
   * Si psavId se provee, restringe la búsqueda a ese agente.
   */
  async getDepositAccount(type: string, currency: string, psavId?: string) {
    let query = this.supabase
      .from('psav_accounts')
      .select('*')
      .eq('type', type)
      .eq('currency', currency.toUpperCase())
      .eq('is_active', true);

    if (psavId) {
      query = query.eq('psav_id', psavId);
    }

    const { data, error } = await query.limit(1).single();

    if (error || !data) {
      throw new NotFoundException(
        `No hay cuenta PSAV activa para ${type}/${currency}${psavId ? ` (PSAV ${psavId})` : ''}`,
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
   * Se usa para resolución dinámica en flujos off-ramp.
   */
  async getActiveCryptoAccounts(psavId?: string) {
    let query = this.supabase
      .from('psav_accounts')
      .select('*')
      .eq('type', 'crypto')
      .eq('is_active', true)
      .order('currency');

    if (psavId) {
      query = query.eq('psav_id', psavId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  // ── Admin CRUD de canales (psav_accounts) ──────────────────────

  async listAccounts(psavId?: string) {
    let query = this.supabase
      .from('psav_accounts')
      .select('*, psav:psavs(id, name)')
      .order('type')
      .order('currency');

    if (psavId) {
      query = query.eq('psav_id', psavId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  async createAccount(dto: {
    psav_id: string;
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

    this.adminGateway.emitPsavConfigUpdated({
      id: data.id,
      name: data.name,
      type: data.type,
      currency: data.currency,
      is_active: data.is_active,
      updated_at: data.updated_at ?? new Date().toISOString(),
      action: 'created',
    });

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
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      throw new NotFoundException('Cuenta PSAV no encontrada');
    }

    this.adminGateway.emitPsavConfigUpdated({
      id: data.id,
      name: data.name,
      type: data.type,
      currency: data.currency,
      is_active: data.is_active,
      updated_at: data.updated_at ?? new Date().toISOString(),
      action: 'updated',
    });

    return data;
  }

  async deactivateAccount(id: string) {
    return this.updateAccount(id, { is_active: false });
  }

  async deleteAccount(id: string) {
    const { error } = await this.supabase
      .from('psav_accounts')
      .delete()
      .eq('id', id);

    if (error) throw error;

    this.adminGateway.emitPsavConfigUpdated({
      id,
      name: '',
      type: '',
      currency: '',
      is_active: false,
      updated_at: new Date().toISOString(),
      action: 'deleted',
    });
  }

  // ── Admin CRUD de agentes PSAV ──────────────────────────────────

  async listPsavs() {
    const { data, error } = await this.supabase
      .from('psavs')
      .select(`
        id,
        name,
        verification_code,
        is_active,
        created_at,
        updated_at,
        channels:psav_accounts(id, name, type, currency, is_active, bank_name, account_number, routing_number, account_holder, qr_url, crypto_address, crypto_network),
        assigned_count:profiles(count)
      `)
      .order('name');

    if (error) throw error;
    return data ?? [];
  }

  async createPsav(dto: CreatePsavDto) {
    const { data, error } = await this.supabase
      .from('psavs')
      .insert({ ...dto, is_active: true })
      .select()
      .single();

    if (error) throw error;
    this.logger.log(`PSAV creado: ${data.id} — ${data.name}`);
    return data;
  }

  async updatePsav(id: string, dto: UpdatePsavDto) {
    const { data, error } = await this.supabase
      .from('psavs')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      throw new NotFoundException('Agente PSAV no encontrado');
    }

    return data;
  }

  async deactivatePsav(id: string) {
    return this.updatePsav(id, { is_active: false });
  }

  async listAssignedClients(psavId: string) {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('id, full_name, email, onboarding_status, role, created_at, avatar_url, country_code')
      .eq('assigned_psav_id', psavId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data ?? [];
  }

  // ── Asignación de PSAV a usuarios ──────────────────────────────

  /**
   * Asigna el PSAV activo con menos clientes al usuario dado.
   * Se llama automáticamente al aprobar KYC/KYB del cliente.
   */
  async assignPsavEquitably(userId: string): Promise<void> {
    // Contar clientes asignados por PSAV activo
    const { data: psavs, error } = await this.supabase
      .from('psavs')
      .select('id, profiles(count)')
      .eq('is_active', true);

    if (error || !psavs?.length) {
      this.logger.warn(
        `assignPsavEquitably: no hay PSAVs activos para asignar al usuario ${userId}`,
      );
      return;
    }

    // Elegir el PSAV con menos usuarios asignados
    const sorted = [...psavs].sort((a, b) => {
      const countA = (a.profiles as unknown as { count: number }[])[0]?.count ?? 0;
      const countB = (b.profiles as unknown as { count: number }[])[0]?.count ?? 0;
      return countA - countB;
    });

    const chosen = sorted[0];

    const { error: updateError } = await this.supabase
      .from('profiles')
      .update({ assigned_psav_id: chosen.id })
      .eq('id', userId);

    if (updateError) {
      this.logger.error(
        `assignPsavEquitably: error al asignar PSAV ${chosen.id} a usuario ${userId}`,
        updateError,
      );
    } else {
      this.logger.log(
        `PSAV ${chosen.id} asignado equitativamente al usuario ${userId}`,
      );
    }
  }

  /**
   * Permite al admin asignar (o reasignar) un PSAV específico a un usuario.
   */
  async assignPsavToUser(userId: string, psavId: string): Promise<void> {
    // Verificar que el PSAV existe y está activo
    const { data: psav, error: psavError } = await this.supabase
      .from('psavs')
      .select('id, name')
      .eq('id', psavId)
      .single();

    if (psavError || !psav) {
      throw new NotFoundException('Agente PSAV no encontrado');
    }

    const { error } = await this.supabase
      .from('profiles')
      .update({ assigned_psav_id: psavId })
      .eq('id', userId);

    if (error) throw error;

    this.logger.log(
      `Admin reasignó PSAV "${psav.name}" (${psavId}) al usuario ${userId}`,
    );
  }
}

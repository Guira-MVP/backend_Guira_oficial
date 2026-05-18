import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';

export interface CreateLedgerEntryParams {
  wallet_id: string;
  type: 'credit' | 'debit';
  amount: number;
  currency: string;
  status: 'pending' | 'settled' | 'failed' | 'reversed';
  reference_type?: string;
  reference_id?: string;
  bridge_transfer_id?: string;
  description: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  // ───────────────────────────────────────────────
  //  Endpoints de usuario
  // ───────────────────────────────────────────────

  /** Historial de ledger del usuario con filtros y paginación. */
  async getHistory(
    userId: string,
    filters: {
      from?: string;
      to?: string;
      type?: string;
      currency?: string;
      status?: string;
    },
    page = 1,
    limit = 50,
  ) {
    const offset = (page - 1) * limit;
    const safeLimit = Math.min(limit, 100);

    // 1. Obtener wallet IDs del usuario
    const { data: wallets, error: walletsError } = await this.supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId);

    if (walletsError) {
      this.logger.error(
        `Error obteniendo wallets para user ${userId}: ${walletsError.message}`,
      );
      throw new BadRequestException(walletsError.message);
    }

    const walletIds = wallets?.map((w) => w.id) ?? [];

    // Si el usuario no tiene wallets, retornar vacío inmediatamente
    if (walletIds.length === 0) {
      this.logger.warn(`Usuario ${userId} no tiene wallets — ledger vacío`);
      return {
        entries: [],
        pagination: { page, limit: safeLimit, total: 0, totalPages: 0 },
      };
    }

    // 2. Construir query con filtros ANTES de paginación
    let query = this.supabase
      .from('ledger_entries')
      .select(
        'id, type, amount, currency, status, reference_type, reference_id, description, metadata, created_at, wallet_id',
        { count: 'exact' },
      )
      .in('wallet_id', walletIds);

    // Aplicar filtros de negocio
    if (filters.from) {
      query = query.gte('created_at', filters.from);
    }
    if (filters.to) {
      query = query.lte('created_at', filters.to);
    }
    if (filters.type) {
      query = query.eq('type', filters.type);
    }
    if (filters.currency) {
      query = query.eq('currency', filters.currency.toUpperCase());
    }
    if (filters.status) {
      query = query.eq('status', filters.status);
    }

    // 3. Ordenar y paginar al final
    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + safeLimit - 1);

    const { data, error, count } = await query;

    if (error) throw new BadRequestException(error.message);

    this.logger.debug(
      `Ledger history: user=${userId}, wallets=${walletIds.length}, entries=${data?.length ?? 0}, total=${count ?? 0}, filters=${JSON.stringify(filters)}`,
    );

    return {
      entries: data ?? [],
      pagination: {
        page,
        limit: safeLimit,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / safeLimit),
      },
    };
  }

  /** Detalle de una entrada del ledger (verificando propiedad). */
  async getEntry(entryId: string, userId: string) {
    const { data, error } = await this.supabase
      .from('ledger_entries')
      .select('*, wallets!inner(user_id)')
      .eq('id', entryId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Entrada de ledger no encontrada');
    }

    // Verificar propiedad
    const wallet = data.wallets as unknown as { user_id: string };
    if (wallet.user_id !== userId) {
      throw new NotFoundException('Entrada de ledger no encontrada');
    }

    // Retornar sin el join de wallets
    const { wallets: _w, ...entry } = data;
    return entry;
  }

  // ───────────────────────────────────────────────
  //  Servicio interno — Helper central
  // ───────────────────────────────────────────────

  /**
   * Crea una entrada en el ledger.
   * El trigger de DB actualiza automáticamente los balances cuando status = 'settled'.
   */
  async createEntry(params: CreateLedgerEntryParams): Promise<{ id: string }> {
    const { data, error } = await this.supabase
      .from('ledger_entries')
      .insert({
        wallet_id: params.wallet_id,
        type: params.type,
        amount: params.amount,
        currency: params.currency.toUpperCase(),
        status: params.status,
        reference_type: params.reference_type ?? null,
        reference_id: params.reference_id ?? null,
        bridge_transfer_id: params.bridge_transfer_id ?? null,
        description: params.description,
        metadata: params.metadata ?? null,
      })
      .select('id')
      .single();

    if (error) {
      this.logger.error(`Error creando ledger entry: ${error.message}`);
      throw new BadRequestException(
        `Error creando entrada de ledger: ${error.message}`,
      );
    }

    this.logger.log(
      `Ledger entry creado: ${data.id} | ${params.type} ${params.amount} ${params.currency} [${params.status}]`,
    );
    return data;
  }

  /**
   * Transiciona un ledger entry de 'pending' a 'settled' (o 'failed'/'reversed').
   * El trigger de DB actualiza automáticamente los balances.
   */
  async settleEntry(
    entryId: string,
    newStatus: 'settled' | 'failed' | 'reversed',
  ): Promise<void> {
    const { error } = await this.supabase
      .from('ledger_entries')
      .update({ status: newStatus })
      .eq('id', entryId)
      .eq('status', 'pending'); // Solo transicionar desde pending

    if (error) {
      throw new BadRequestException(
        `Error actualizando ledger entry: ${error.message}`,
      );
    }

    this.logger.log(`Ledger entry ${entryId} → ${newStatus}`);
  }

  // ───────────────────────────────────────────────
  //  Admin — Ajuste manual
  // ───────────────────────────────────────────────

  /** Crea un ajuste manual de ledger (admin). */
  async createAdjustment(
    walletId: string,
    type: 'credit' | 'debit',
    amount: number,
    currency: string,
    reason: string,
    actorId: string,
  ) {
    const entry = await this.createEntry({
      wallet_id: walletId,
      type,
      amount: Math.abs(amount),
      currency,
      status: 'settled', // Ajustes van directo a settled
      reference_type: 'manual_adjustment',
      description: reason,
      metadata: { adjusted_by: actorId },
    });

    // Audit log
    await this.supabase.from('audit_logs').insert({
      actor_id: actorId,
      action: 'ledger_manual_adjustment',
      entity_type: 'ledger_entry',
      entity_id: entry.id,
      details: { wallet_id: walletId, type, amount, currency, reason },
    });

    return entry;
  }
}

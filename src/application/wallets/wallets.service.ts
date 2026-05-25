import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { BridgeApiClient } from '../bridge/bridge-api.client';

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
    private readonly bridgeApi: BridgeApiClient,
  ) {}

  // ───────────────────────────────────────────────
  //  Endpoints de usuario
  // ───────────────────────────────────────────────

  /** Lista wallets activas del usuario junto con sus balances multi-token. */
  async findAllByUser(userId: string) {
    const { data: wallets, error } = await this.supabase
      .from('wallets')
      .select(
        'id, address, network, provider_key, provider_wallet_id, label, is_active, created_at',
      )
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    if (!wallets || wallets.length === 0) return [];

    // Obtener TODOS los balances del usuario
    const { data: balances } = await this.supabase
      .from('balances')
      .select('currency, amount, available_amount, reserved_amount')
      .eq('user_id', userId);

    const balanceList = (balances ?? []).map((b) => ({
      currency: b.currency?.toUpperCase(),
      balance: parseFloat(b.amount ?? '0') || 0,
      available_balance: parseFloat(b.available_amount ?? '0') || 0,
      reserved_balance: parseFloat(b.reserved_amount ?? '0') || 0,
    }));

    // Obtener la config actual para saber qué currencies aplican a cada network
    const walletConfigs = await this.getWalletConfigs();
    const networkCurrenciesMap = new Map<string, string[]>();
    for (const wc of walletConfigs) {
      networkCurrenciesMap.set(wc.network, wc.currencies);
    }

    return wallets.map((w) => {
      // Obtener las currencies soportadas para esta wallet según su network
      const supportedCurrencies = networkCurrenciesMap.get(w.network ?? '') ?? ['USDC'];

      // Filtrar balances que corresponden a las currencies soportadas en esta network
      const tokenBalances = supportedCurrencies.map((cur) => {
        const curUpper = cur.toUpperCase();
        const bal = balanceList.find((b) => b.currency === curUpper);
        return {
          currency: curUpper,
          balance: bal?.balance ?? 0,
          available_balance: bal?.available_balance ?? 0,
          reserved_balance: bal?.reserved_balance ?? 0,
        };
      });

      // Totales agregados (suma de todos los tokens)
      const totalBalance = tokenBalances.reduce((sum, t) => sum + t.balance, 0);
      const totalAvailable = tokenBalances.reduce(
        (sum, t) => sum + t.available_balance,
        0,
      );
      const totalReserved = tokenBalances.reduce(
        (sum, t) => sum + t.reserved_balance,
        0,
      );

      return {
        id: w.id,
        address: w.address,
        network: w.network,
        provider: w.provider_key ?? 'bridge',
        provider_wallet_id: w.provider_wallet_id ?? null,
        label: w.label,
        is_active: w.is_active,
        created_at: w.created_at,
        // Balances multi-token
        token_balances: tokenBalances,
        // Totales agregados (retrocompatibilidad)
        balance: totalBalance,
        available_balance: totalAvailable,
        reserved_balance: totalReserved,
      };
    });
  }

  /** Obtiene wallet específica verificando propiedad. */
  async findOne(walletId: string, userId: string) {
    const { data, error } = await this.supabase
      .from('wallets')
      .select('*')
      .eq('id', walletId)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Wallet no encontrada');
    return data;
  }

  /** Balances del usuario (todas las monedas). */
  async getBalances(userId: string) {
    const { data, error } = await this.supabase
      .from('balances')
      .select(
        'id, currency, amount, available_amount, pending_amount, reserved_amount, updated_at',
      )
      .eq('user_id', userId)
      .order('currency', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  /** Resumen admin de wallets y balances de un usuario. */
  async findAllByUserForAdmin(userId: string) {
    const { data: wallets, error: walletsError } = await this.supabase
      .from('wallets')
      .select(
        'id, address, network, provider_key, provider_wallet_id, label, is_active, created_at',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true });

    if (walletsError) throw new BadRequestException(walletsError.message);

    const { data: balances, error: balancesError } = await this.supabase
      .from('balances')
      .select(
        'id, currency, amount, available_amount, pending_amount, reserved_amount, updated_at',
      )
      .eq('user_id', userId)
      .order('currency', { ascending: true });

    if (balancesError) throw new BadRequestException(balancesError.message);

    const normalizedBalances = (balances ?? []).map((balance) => ({
      id: balance.id,
      currency: balance.currency?.toUpperCase(),
      amount: this.toNumber(balance.amount),
      available_amount: this.toNumber(balance.available_amount),
      pending_amount: this.toNumber(balance.pending_amount),
      reserved_amount: this.toNumber(balance.reserved_amount),
      updated_at: balance.updated_at,
    }));

    const totals = normalizedBalances.reduce(
      (acc, balance) => ({
        amount: acc.amount + balance.amount,
        available_amount: acc.available_amount + balance.available_amount,
        pending_amount: acc.pending_amount + balance.pending_amount,
        reserved_amount: acc.reserved_amount + balance.reserved_amount,
      }),
      {
        amount: 0,
        available_amount: 0,
        pending_amount: 0,
        reserved_amount: 0,
      },
    );

    return {
      wallets: wallets ?? [],
      balances: normalizedBalances,
      totals,
    };
  }

  /** Balance de una divisa específica. */
  async getBalanceByCurrency(userId: string, currency: string) {
    const { data, error } = await this.supabase
      .from('balances')
      .select('*')
      .eq('user_id', userId)
      .eq('currency', currency.toUpperCase())
      .single();

    if (error || !data) {
      throw new NotFoundException(`No existe balance para ${currency}`);
    }
    return data;
  }

  /** Rutas de payin del usuario (cuentas virtuales). */
  async getPayinRoutes(userId: string) {
    const { data, error } = await this.supabase
      .from('payin_routes')
      .select(
        `
        *,
        bridge_virtual_accounts (
          id, va_id, currency, status, bank_name, account_number, routing_number
        )
      `,
      )
      .eq('user_id', userId)
      .eq('is_active', true);

    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  // ───────────────────────────────────────────────
  //  Servicios internos — Inicialización de cliente
  // ───────────────────────────────────────────────

  /**
   * Inicializa las wallets de un cliente aprobado.
   * Lee el bridge_customer_id del perfil del usuario si no se provee.
   * Lee la configuración de wallets desde app_settings.
   *
   * IMPORTANTE: Bridge crea UNA wallet por chain (no por currency).
   * Una sola wallet Solana puede contener múltiples stablecoins (USDC, USDT, USDB, PYUSD, EURC).
   * Por lo tanto, se crea UNA llamada a Bridge por network único y se inicializan
   * filas de balance para TODAS las currencies soportadas en ese network.
   */
  async initializeClientWallets(
    userId: string,
    bridgeCustomerId?: string,
  ): Promise<{ initialized: number; message: string }> {
    // Si no se provee, leer del perfil
    let customerId = bridgeCustomerId ?? null;
    if (!customerId) {
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('bridge_customer_id')
        .eq('id', userId)
        .single();
      customerId = profile?.bridge_customer_id ?? null;
    }

    if (!customerId) {
      throw new NotFoundException(
        `El usuario ${userId} no tiene bridge_customer_id — no se pueden crear wallets en Bridge.`,
      );
    }

    // Leer configuración desde app_settings (formato: [{network, currencies[]}])
    const walletConfigs = await this.getWalletConfigs();
    let initialized = 0;

    // Iterar por NETWORKS únicos — Bridge crea UNA wallet por chain
    for (const wc of walletConfigs) {
      // Verificar si ya existe una wallet para este network
      const { data: existing } = await this.supabase
        .from('wallets')
        .select('id')
        .eq('user_id', userId)
        .eq('network', wc.network)
        .eq('is_active', true)
        .maybeSingle();

      if (existing) {
        this.logger.log(
          `Wallet ${wc.network} ya existe para user ${userId}, omitiendo creación en Bridge`,
        );
      } else {
        // Crear UNA wallet en Bridge para este network
        const bridgeWallet = await this.createBridgeWallet(
          customerId,
          wc.network,
        );

        // Guardar en DB
        // - network: fuente de verdad = Bridge response.chain (D-4)
        // - currency: currency principal/legacy — el desglose real vive en tabla balances (D-5)
        const chainFromBridge = bridgeWallet.chain ?? wc.network;
        await this.supabase.from('wallets').insert({
          user_id: userId,
          address: bridgeWallet.address,
          network: chainFromBridge,
          provider_key: 'bridge',
          provider_wallet_id: bridgeWallet.id,
          label: `Wallet ${chainFromBridge.charAt(0).toUpperCase() + chainFromBridge.slice(1)}`,
          is_active: true,
        });

        initialized++;
      }

      // Inicializar balances para TODAS las currencies de este network
      await this.initializeBalances(
        userId,
        wc.currencies.map((c) => c.toUpperCase()),
      );
    }

    this.logger.log(
      `Wallets inicializados para usuario ${userId}: ${initialized} nuevas de ${walletConfigs.length} configuraciones`,
    );

    return {
      initialized,
      message: `${initialized} wallet(s) inicializadas correctamente para el usuario ${userId}.`,
    };
  }

  /**
   * Inicializa filas de balance con valor 0 para las monedas indicadas.
   * Siempre incluye USD (fiat base).
   */
  async initializeBalances(
    userId: string,
    currencies: string[],
  ): Promise<void> {
    const uniqueCurrencies = [...new Set([...currencies, 'USD'])];

    for (const currency of uniqueCurrencies) {
      // Verificar si ya existe
      const { data: existing } = await this.supabase
        .from('balances')
        .select('id')
        .eq('user_id', userId)
        .eq('currency', currency)
        .maybeSingle();

      if (existing) continue;

      await this.supabase.from('balances').insert({
        user_id: userId,
        currency,
        amount: 0,
        available_amount: 0,
        pending_amount: 0,
        reserved_amount: 0,
      });
    }
  }

  // ───────────────────────────────────────────────
  //  Admin — Ajuste manual de balance
  // ───────────────────────────────────────────────

  /** Ajuste manual de balance por parte de un admin (con audit_log). */
  async adjustBalance(
    targetUserId: string,
    currency: string,
    adjustmentAmount: number,
    reason: string,
    actorId: string,
  ) {
    const upperCurrency = currency.toUpperCase();

    // Obtener balance actual
    const { data: balance, error } = await this.supabase
      .from('balances')
      .select('*')
      .eq('user_id', targetUserId)
      .eq('currency', upperCurrency)
      .single();

    if (error || !balance) {
      throw new NotFoundException(
        `No existe balance de ${upperCurrency} para el usuario`,
      );
    }

    const newAmount = parseFloat(balance.amount) + adjustmentAmount;
    const newAvailable =
      parseFloat(balance.available_amount) + adjustmentAmount;

    if (newAvailable < 0) {
      throw new BadRequestException(
        'El ajuste resultaría en un saldo disponible negativo',
      );
    }

    // Actualizar balance
    const { data: updated, error: updateErr } = await this.supabase
      .from('balances')
      .update({
        amount: newAmount,
        available_amount: newAvailable,
        updated_at: new Date().toISOString(),
      })
      .eq('id', balance.id)
      .select()
      .single();

    if (updateErr) throw new BadRequestException(updateErr.message);

    // Audit log
    await this.supabase.from('audit_logs').insert({
      actor_id: actorId,
      action: 'balance_manual_adjustment',
      entity_type: 'balance',
      entity_id: balance.id,
      details: {
        user_id: targetUserId,
        currency: upperCurrency,
        adjustment: adjustmentAmount,
        previous_amount: balance.amount,
        new_amount: newAmount,
        reason,
      },
    });

    this.logger.log(
      `Ajuste de balance: ${adjustmentAmount} ${upperCurrency} para ${targetUserId} por ${actorId}`,
    );

    return updated;
  }

  // ───────────────────────────────────────────────
  //  Helpers privados
  // ───────────────────────────────────────────────

  /**
   * Lee la configuración de wallets soportadas desde app_settings.
   *
   * Formato nuevo (multi-token):
   *   [{"network":"solana","currencies":["usdc","usdt","usdb","pyusd","eurc"]}]
   *
   * Formato legacy (compatibilidad):
   *   [{"currency":"usdc","network":"solana"}]
   *
   * Siempre retorna el formato normalizado: Array<{network, currencies[]}>.
   * Fallback: Solana con USDC si la config no existe o es inválida.
   */
  private async getWalletConfigs(): Promise<
    Array<{ network: string; currencies: string[] }>
  > {
    const SOLANA_FALLBACK = [{ network: 'solana', currencies: ['usdc'] }];

    const { data } = await this.supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'SUPPORTED_WALLET_CONFIGS')
      .single();

    if (!data?.value) {
      this.logger.warn(
        'SUPPORTED_WALLET_CONFIGS no encontrado en app_settings — usando fallback Solana/USDC',
      );
      return SOLANA_FALLBACK;
    }

    try {
      const parsed = JSON.parse(data.value);
      if (!Array.isArray(parsed) || parsed.length === 0) return SOLANA_FALLBACK;

      // Detectar formato: nuevo {network, currencies[]} vs legacy {currency, network}
      if (parsed[0].currencies && Array.isArray(parsed[0].currencies)) {
        // Formato nuevo
        return parsed;
      }

      // Formato legacy — agrupar por network
      const grouped = new Map<string, string[]>();
      for (const entry of parsed) {
        const net = entry.network ?? 'solana';
        const cur = entry.currency ?? 'usdc';
        if (!grouped.has(net)) grouped.set(net, []);
        grouped.get(net)!.push(cur);
      }
      return Array.from(grouped.entries()).map(([network, currencies]) => ({
        network,
        currencies,
      }));
    } catch {
      this.logger.error(
        'Error parseando SUPPORTED_WALLET_CONFIGS — usando fallback Solana/USDC',
      );
      return SOLANA_FALLBACK;
    }
  }

  /**
   * Crea una Bridge Wallet vía Bridge API.
   *
   * Según la documentación de Bridge:
   * - Endpoint: POST /v0/customers/{customerID}/wallets
   * - Body requerido: { chain } (enum: base, ethereum, solana, tempo, tron)
   * - Header requerido: Idempotency-Key
   * - Respuesta: { id, chain, address, created_at, updated_at }
   */
  private async createBridgeWallet(
    bridgeCustomerId: string,
    network: string,
  ): Promise<{ id: string; address: string; chain: string }> {
    const idempotencyKey = `wallet-${bridgeCustomerId}-${network}`;

    const response = await this.bridgeApi.post<{
      id: string;
      chain: string;
      address: string;
      created_at: string;
      updated_at: string;
    }>(
      `/v0/customers/${bridgeCustomerId}/wallets`,
      { chain: network },
      idempotencyKey,
    );

    return {
      id: response.id,
      address: response.address,
      chain: response.chain,
    };
  }

  private toNumber(value: unknown): number {
    const numeric =
      typeof value === 'number' ? value : parseFloat(String(value ?? '0'));
    return Number.isFinite(numeric) ? numeric : 0;
  }
}

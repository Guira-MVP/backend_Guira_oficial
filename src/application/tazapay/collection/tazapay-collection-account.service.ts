import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';
import { TazapayApiClient, TazapayApiError } from '../tazapay-api.client';

export const TAZAPAY_COLLECTION_WALLET_ENABLED_SETTING_KEY =
  'TAZAPAY_COLLECTION_WALLET_ENABLED';

/** Wallet de fondeo: USDC en Solana, la misma red de la wallet Bridge y del PSAV. */
export const COLLECTION_PAYMENT_METHOD = 'stablecoin_usdc';
export const COLLECTION_CHAIN = 'solana';

const REQUEST_STATUSES = new Set([
  'processing',
  'requires_action',
  'approval_hold',
  'succeeded',
  'failed',
  'cancelled',
]);
/** Un intento que lleva más que esto sin terminar se considera abandonado. */
const STALE_CLAIM_MS = 5 * 60_000;

export class CollectionWalletError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'CollectionWalletError';
  }
}

/** Datos de una collection account leídos de una respuesta o webhook de Tazapay. */
export interface ParsedCollectionAccount {
  collectionAccountId: string | null;
  entityId: string | null;
  type: string | null;
  paymentMethodType: string | null;
  chain: string | null;
  depositAddress: string | null;
  accountStatus: 'enabled' | 'disabled' | null;
  requestId: string | null;
  requestStatus: string | null;
  failureCode: string | null;
  failureReason: string | null;
  feeDetails: Record<string, unknown> | null;
  balanceTransaction: string | null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Lector tolerante: la documentación de Tazapay se contradice (respuesta con o
 * sin sobre `data`, request `enable`/`enablement`, mayúsculas en la red).
 */
export function parseCollectionAccount(raw: unknown): ParsedCollectionAccount {
  const root = (raw ?? {}) as Record<string, unknown>;
  const acc = ((root.data as Record<string, unknown>) ?? root) as Record<
    string,
    unknown
  >;
  const wallet = (acc.wallet ?? {}) as Record<string, unknown>;
  const requests = Array.isArray(acc.requests)
    ? (acc.requests as Record<string, unknown>[])
    : [];
  // requests viene de la más nueva a la más vieja; se toma la última de habilitación.
  const enableReq =
    requests.find((r) =>
      ['enable', 'enablement'].includes(String(r.type ?? '').toLowerCase()),
    ) ?? requests[0];
  const reqStatus = str(enableReq?.status)?.toLowerCase() ?? null;
  const status = str(acc.status)?.toLowerCase();
  return {
    collectionAccountId: str(acc.id),
    entityId: str(acc.entity_id) ?? str(acc.on_behalf_of),
    type: str(acc.type)?.toLowerCase() ?? null,
    paymentMethodType: str(acc.payment_method_type)?.toLowerCase() ?? null,
    chain: str(wallet.type)?.toLowerCase() ?? null,
    depositAddress: str(wallet.deposit_address),
    accountStatus:
      status === 'enabled' || status === 'disabled' ? status : null,
    requestId: str(enableReq?.id),
    requestStatus:
      reqStatus && REQUEST_STATUSES.has(reqStatus) ? reqStatus : null,
    failureCode: str(enableReq?.failure_code),
    failureReason: str(enableReq?.failure_reason) ?? str(acc.failure_reason),
    feeDetails:
      acc.fee_details && typeof acc.fee_details === 'object'
        ? (acc.fee_details as Record<string, unknown>)
        : null,
    balanceTransaction: str(acc.balance_transaction),
  };
}

/** Código numérico de error de Tazapay (6121, 6133…) dentro del mensaje redactado. */
export function tazapayErrorCode(err: unknown): string | null {
  if (!(err instanceof TazapayApiError) || !err.providerMessage) return null;
  const m = /"code"\s*:\s*"?(\d+)/.exec(err.providerMessage);
  return m ? m[1] : null;
}

function isOurWallet(p: ParsedCollectionAccount): boolean {
  return (
    p.type === 'wallet' &&
    p.paymentMethodType === COLLECTION_PAYMENT_METHOD &&
    p.chain === COLLECTION_CHAIN
  );
}

/** Estado de un collect a partir del evento (collect.succeeded → succeeded). */
export function collectStatus(
  eventType: string,
  data: Record<string, unknown>,
) {
  const fromEvent = eventType.split('.')[1]?.toLowerCase();
  const raw = (fromEvent || String(data.status ?? '')).toLowerCase();
  const allowed = ['detected', 'succeeded', 'failed', 'on_hold', 'reversed'];
  return allowed.includes(raw) ? raw : 'unknown';
}

/**
 * Wallet de fondeo de Tazapay por cliente: collection account tipo `wallet`
 * (USDC/Solana) creada on_behalf_of la entity del cliente. Uso interno: es el
 * destino del dinero que se envía a Tazapay (PSAV en bolivia_to_world o la
 * wallet Bridge del cliente en bridge_wallet_to_fiat_us) antes del payout SWIFT.
 *
 * La wallet es irreversible (no se puede deshabilitar) y su alta se cobra al
 * balance de Guira, así que nunca se crea dos veces: se reserva la fila en
 * tazapay_collection_accounts (UNIQUE por cliente), se busca primero en
 * Tazapay y se usa una Idempotency-Key determinística.
 * Auditoría: Docuemntacion_nueva_integracion/06_fondeo_y_wallets/
 * AUDITORIA_CREACION_COLLECTION_ACCOUNT_TAZAPAY_2026-09-28.md
 */
@Injectable()
export class TazapayCollectionAccountService {
  private readonly logger = new Logger(TazapayCollectionAccountService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly api: TazapayApiClient,
  ) {}

  get isConfigured(): boolean {
    return this.api.isConfigured;
  }

  async isAutoCreateEnabled(): Promise<boolean> {
    const { data } = await this.supabase
      .from('app_settings')
      .select('value')
      .eq('key', TAZAPAY_COLLECTION_WALLET_ENABLED_SETTING_KEY)
      .maybeSingle();
    return String(data?.value ?? '').toLowerCase() === 'true';
  }

  static idempotencyKey(userId: string): string {
    return `tz_cwa_${userId}_${COLLECTION_PAYMENT_METHOD}_${COLLECTION_CHAIN}`;
  }

  /** La wallet de fondeo del cliente (panel staff: Cuentas → Tazapay). */
  async getWallet(userId: string) {
    const { data } = await this.supabase
      .from('tazapay_collection_accounts')
      .select(
        'collection_account_id, entity_id, payment_method_type, chain, deposit_address, account_status, request_status, failure_code, failure_reason, transfer_limit_min, transfer_limit_max, limit_currency, restricted_remitter_countries, setup_time, fee_details, enabled_at, created_at, updated_at',
      )
      .eq('user_id', userId)
      .eq('payment_method_type', COLLECTION_PAYMENT_METHOD)
      .eq('chain', COLLECTION_CHAIN)
      .maybeSingle();
    return data ?? null;
  }

  /** Depósitos recibidos en la wallet del cliente, paginados (Instrucciones → Depósitos). */
  async listCollects(userId: string, limit = 20, offset = 0) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safeOffset = Math.max(offset, 0);
    const { data, count } = await this.supabase
      .from('tazapay_collects')
      .select(
        'collect_id, collection_account_id, status, amount, currency, holding_currency, payment_method_type, balance_transaction, payer_wallet, payer_network, tx_hash, payment_order_id, created_at, updated_at',
        { count: 'exact' },
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(safeOffset, safeOffset + safeLimit - 1);
    return {
      items: data ?? [],
      total: count ?? 0,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  /**
   * Crea (o adopta, si ya existe en Tazapay) la wallet de fondeo del cliente.
   * Idempotente: si ya hay una, la devuelve sin llamar a crear.
   */
  async ensureCollectionWallet(userId: string) {
    if (!this.api.isConfigured) {
      throw new CollectionWalletError(
        'Tazapay no está configurado (TAZAPAY_API_KEY / TAZAPAY_API_SECRET).',
        'not_configured',
      );
    }

    const existing = await this.findRow(userId);
    if (existing?.collection_account_id) return existing;

    const entityId = await this.approvedEntityId(userId);

    // Reserva de la fila: el UNIQUE(user_id, payment_method_type, chain) hace
    // de candado entre dos procesos que intentan crear a la vez.
    const row = await this.claimRow(userId, entityId, existing);

    try {
      // 1. ¿Ya existe en Tazapay? (creada antes, o se perdió la respuesta.)
      const adopted = await this.findInTazapay(entityId);
      if (adopted) return this.saveParsed(row.id as string, adopted);

      // 2. Metadata: la red exacta, límites y requisitos para esta entity.
      const meta = await this.walletMetadata(entityId);

      // 3. Crear.
      let created: unknown;
      try {
        created = await this.api.post(
          '/v3/collection_account',
          {
            type: 'wallet',
            payment_method_type: COLLECTION_PAYMENT_METHOD,
            wallet: { type: meta.network },
            on_behalf_of: entityId,
            alias: await this.alias(userId),
            description:
              'Wallet de fondeo interna de Guira: recibe USDC del PSAV o de la wallet Bridge del cliente para pagos SWIFT.',
            metadata: { guira_user_id: userId, purpose: 'swift_funding' },
          },
          TazapayCollectionAccountService.idempotencyKey(userId),
        );
      } catch (err) {
        if (tazapayErrorCode(err) === '6133') {
          // "Ya existe una cuenta habilitada": se adopta.
          const again = await this.findInTazapay(entityId);
          if (again) return this.saveParsed(row.id as string, again);
        }
        throw err;
      }

      await this.supabase
        .from('tazapay_collection_accounts')
        .update({
          transfer_limit_min: meta.limitMin,
          transfer_limit_max: meta.limitMax,
          limit_currency: meta.limitCurrency,
          restricted_remitter_countries: meta.restrictedRemitterCountries,
          setup_time: meta.setupTime,
        })
        .eq('id', row.id);
      return this.saveParsed(
        row.id as string,
        parseCollectionAccount(created),
        created,
      );
    } catch (err) {
      const code =
        tazapayErrorCode(err) ??
        (err instanceof CollectionWalletError ? err.code : null) ??
        (err instanceof TazapayApiError
          ? String(err.status ?? 'network')
          : 'error');
      const retryable =
        err instanceof TazapayApiError && err.retryable && code !== '6121';
      const reason =
        code === '6121'
          ? 'Saldo insuficiente en Tazapay para la comisión de alta de la wallet.'
          : err instanceof TazapayApiError && err.providerMessage
            ? `${err.message} — ${err.providerMessage}`
            : (err as Error).message;
      this.logger.error(`Wallet de fondeo Tazapay de ${userId}: ${reason}`);
      await this.supabase
        .from('tazapay_collection_accounts')
        .update({
          // Un fallo técnico deja la fila en `pending` para reintentar.
          request_status: retryable ? 'pending' : 'failed',
          failure_code: code,
          failure_reason: reason.slice(0, 1000),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      throw err;
    }
  }

  /** Consulta la cuenta en Tazapay y actualiza su estado (polling). */
  async refresh(collectionAccountId: string) {
    const { data: row } = await this.supabase
      .from('tazapay_collection_accounts')
      .select('id')
      .eq('collection_account_id', collectionAccountId)
      .maybeSingle();
    if (!row) return null;
    const res = await this.api.get(
      `/v3/collection_account/${collectionAccountId}`,
    );
    return this.saveParsed(row.id as string, parseCollectionAccount(res), res);
  }

  /**
   * Polling de las cuentas que no terminaron de habilitarse: Tazapay todavía
   * no envía los webhooks de fallo (creation_failed, requires_action…).
   * Cada minuto los primeros 15 minutos, después cada 15 minutos.
   */
  async pollPending(): Promise<void> {
    if (!this.api.isConfigured) return;
    const { data: rows } = await this.supabase
      .from('tazapay_collection_accounts')
      .select('collection_account_id, created_at, last_checked_at')
      .in('request_status', ['processing', 'requires_action', 'approval_hold'])
      .not('collection_account_id', 'is', null)
      .limit(25);
    const now = Date.now();
    for (const r of rows ?? []) {
      const age = now - new Date(r.created_at as string).getTime();
      const last = r.last_checked_at
        ? now - new Date(r.last_checked_at as string).getTime()
        : Infinity;
      const every = age < 15 * 60_000 ? 60_000 : 15 * 60_000;
      if (last < every) continue;
      try {
        await this.refresh(r.collection_account_id as string);
      } catch (err) {
        this.logger.warn(
          `Polling wallet ${String(r.collection_account_id)}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Webhook collection_account.* → estado de la wallet. */
  async applyCollectionAccountEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const parsed = parseCollectionAccount(payload.data ?? {});
    if (!parsed.collectionAccountId) return;
    const { data: row } = await this.supabase
      .from('tazapay_collection_accounts')
      .select('id')
      .eq('collection_account_id', parsed.collectionAccountId)
      .maybeSingle();
    if (!row) {
      // No confiar en cuentas que Guira no creó.
      this.logger.warn(
        `Webhook ${eventType} para collection account desconocida ${parsed.collectionAccountId}`,
      );
      return;
    }
    await this.saveParsed(row.id as string, parsed, payload.data);
  }

  /** Webhook collect.* → registro del depósito (no acredita saldo todavía). */
  async applyCollectEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const collectId = str(data.id);
    if (!collectId) return;
    const destination =
      str(data.destination) ??
      str(
        (
          (data.destination_details as Record<string, unknown>)
            ?.wallet as Record<string, unknown>
        )?.id,
      );
    const { data: account } = destination
      ? await this.supabase
          .from('tazapay_collection_accounts')
          .select('user_id, entity_id')
          .eq('collection_account_id', destination)
          .maybeSingle()
      : { data: null };
    if (!account) {
      // Depósito a una cuenta que no es wallet de fondeo de un cliente (p. ej.
      // una cuenta directa de Guira): se ignora aquí.
      this.logger.log(
        `collect ${collectId} a ${String(destination)}: no es wallet de fondeo, se ignora`,
      );
      return;
    }
    const payer = ((data.payer_details as Record<string, unknown>)
      ?.payer_wallet ?? {}) as Record<string, unknown>;
    const tracking = (data.tracking_details ?? {}) as Record<string, unknown>;
    await this.supabase.from('tazapay_collects').upsert(
      {
        collect_id: collectId,
        collection_account_id: destination,
        user_id: account.user_id,
        entity_id: str(data.on_behalf_of) ?? account.entity_id,
        status: collectStatus(eventType, data),
        amount: typeof data.amount === 'number' ? data.amount : null,
        currency: str(data.currency),
        payment_method_type: str(data.type),
        holding_currency: str(data.holding_currency),
        balance_transaction: str(data.balance_transaction),
        payer_wallet: str(payer.deposit_address),
        payer_network: str(payer.type),
        tx_hash: str(tracking.transaction_hash),
        raw_payload: data,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'collect_id' },
    );
  }

  // ── Internos ────────────────────────────────────────────────────────────

  private async findRow(userId: string) {
    const { data } = await this.supabase
      .from('tazapay_collection_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('payment_method_type', COLLECTION_PAYMENT_METHOD)
      .eq('chain', COLLECTION_CHAIN)
      .maybeSingle();
    return data as Record<string, unknown> | null;
  }

  private async approvedEntityId(userId: string): Promise<string> {
    const { data } = await this.supabase
      .from('provider_accounts')
      .select('external_id, status')
      .eq('user_id', userId)
      .eq('provider', 'tazapay')
      .maybeSingle();
    if (!data?.external_id) {
      throw new CollectionWalletError(
        'El cliente no tiene entity en Tazapay.',
        'no_entity',
      );
    }
    if (data.status !== 'approved') {
      throw new CollectionWalletError(
        `La entity de Tazapay del cliente no está aprobada (estado: ${String(data.status)}).`,
        'entity_not_approved',
      );
    }
    return String(data.external_id);
  }

  private async claimRow(
    userId: string,
    entityId: string,
    existing: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    const now = new Date();
    if (existing) {
      const updatedAt = new Date(String(existing.updated_at)).getTime();
      const busy =
        existing.request_status === 'pending' &&
        Number(existing.attempt_count ?? 0) > 0 &&
        now.getTime() - updatedAt < STALE_CLAIM_MS;
      if (busy) {
        throw new CollectionWalletError(
          'Ya hay un intento de creación en curso para este cliente.',
          'in_progress',
        );
      }
      const { data } = await this.supabase
        .from('tazapay_collection_accounts')
        .update({
          entity_id: entityId,
          request_status: 'pending',
          failure_code: null,
          failure_reason: null,
          attempt_count: Number(existing.attempt_count ?? 0) + 1,
          updated_at: now.toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      return data as Record<string, unknown>;
    }
    const { data, error } = await this.supabase
      .from('tazapay_collection_accounts')
      .insert({
        user_id: userId,
        entity_id: entityId,
        payment_method_type: COLLECTION_PAYMENT_METHOD,
        chain: COLLECTION_CHAIN,
        idempotency_key: TazapayCollectionAccountService.idempotencyKey(userId),
        attempt_count: 1,
      })
      .select('*')
      .single();
    if (error) {
      // 23505: otro proceso la reservó entre la lectura y el insert.
      throw new CollectionWalletError(
        error.code === '23505'
          ? 'Ya hay un intento de creación en curso para este cliente.'
          : `No se pudo reservar la wallet: ${error.message}`,
        error.code === '23505' ? 'in_progress' : 'db_error',
      );
    }
    return data as Record<string, unknown>;
  }

  private async findInTazapay(
    entityId: string,
  ): Promise<ParsedCollectionAccount | null> {
    const res = await this.api.get<Record<string, unknown>>(
      `/v3/collection_account?entity_id=${encodeURIComponent(entityId)}&type=wallet&limit=50`,
    );
    const list = ((res?.data as Record<string, unknown>)?.data ??
      res?.data ??
      []) as unknown[];
    const items = Array.isArray(list) ? list : [];
    const ours = items
      .map((i) => parseCollectionAccount(i))
      .filter(isOurWallet)
      // Preferir la habilitada; si no, la que sigue en proceso.
      .sort(
        (a, b) =>
          Number(b.accountStatus === 'enabled') -
          Number(a.accountStatus === 'enabled'),
      );
    return ours[0] ?? null;
  }

  private async walletMetadata(entityId: string) {
    const res = await this.api.get<Record<string, unknown>>(
      `/v3/metadata/collection_account/wallet?entity=${encodeURIComponent(entityId)}&on_behalf_of=true&payment_method_type=${COLLECTION_PAYMENT_METHOD}&type=${COLLECTION_CHAIN}`,
    );
    const root = ((res?.data as Record<string, unknown>) ??
      res ??
      {}) as Record<string, unknown>;
    const caps = (
      Array.isArray(root.capabilities) ? root.capabilities : []
    ) as Record<string, unknown>[];
    const cap = caps.find(
      (c) =>
        String(c.payment_method_type ?? '').toLowerCase() ===
        COLLECTION_PAYMENT_METHOD,
    );
    if (!cap) {
      throw new CollectionWalletError(
        'Tazapay no ofrece wallets USDC para esta entity (metadata sin capabilities).',
        'not_available',
      );
    }
    const obo = (cap.on_behalf_of ?? {}) as Record<string, unknown>;
    if (obo.supported === false) {
      throw new CollectionWalletError(
        'Tazapay no permite wallets on_behalf_of para esta entity.',
        'obo_not_supported',
      );
    }
    const networks = (Array.isArray(cap.type) ? cap.type : []) as unknown[];
    // La red tal como la escribe Tazapay ("Solana" o "solana").
    const network =
      (networks.find((n) => String(n).toLowerCase() === COLLECTION_CHAIN) as
        | string
        | undefined) ?? null;
    if (!network) {
      throw new CollectionWalletError(
        'Tazapay no ofrece USDC en Solana para esta entity.',
        'chain_not_available',
      );
    }
    const limit = (cap.transfer_limit ?? {}) as Record<string, unknown>;
    return {
      network,
      limitMin: typeof limit.min_limit === 'number' ? limit.min_limit : null,
      limitMax: typeof limit.max_limit === 'number' ? limit.max_limit : null,
      limitCurrency: str(limit.currency),
      restrictedRemitterCountries: Array.isArray(
        cap.restricted_remitter_countries,
      )
        ? (cap.restricted_remitter_countries as string[])
        : null,
      setupTime: str(cap.setup_time),
    };
  }

  private async alias(userId: string): Promise<string> {
    const { data } = await this.supabase
      .from('profiles')
      .select('full_name')
      .eq('id', userId)
      .maybeSingle();
    const name = String(data?.full_name ?? '')
      .trim()
      .slice(0, 40);
    return `Guira · ${name || userId.slice(0, 8)} · USDC Solana`;
  }

  private async saveParsed(
    rowId: string,
    p: ParsedCollectionAccount,
    raw?: unknown,
  ) {
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      updated_at: now,
      last_checked_at: now,
    };
    if (p.collectionAccountId)
      update.collection_account_id = p.collectionAccountId;
    if (p.entityId) update.entity_id = p.entityId;
    if (p.requestId) update.enable_request_id = p.requestId;
    if (p.depositAddress) update.deposit_address = p.depositAddress;
    if (p.accountStatus) update.account_status = p.accountStatus;
    if (p.requestStatus) update.request_status = p.requestStatus;
    else if (p.accountStatus === 'enabled') update.request_status = 'succeeded';
    else if (p.collectionAccountId) update.request_status = 'processing';
    if (p.failureCode) update.failure_code = p.failureCode;
    if (p.failureReason) update.failure_reason = p.failureReason;
    if (p.requestStatus === 'succeeded' || p.accountStatus === 'enabled') {
      update.failure_code = null;
      update.failure_reason = null;
    }
    if (p.feeDetails) update.fee_details = p.feeDetails;
    if (p.balanceTransaction) update.balance_transaction = p.balanceTransaction;
    if (p.accountStatus === 'enabled') update.enabled_at = now;
    if (raw !== undefined) update.raw_last_response = raw;

    const { data } = await this.supabase
      .from('tazapay_collection_accounts')
      .update(update)
      .eq('id', rowId)
      .select('*')
      .single();
    return data as Record<string, unknown>;
  }
}

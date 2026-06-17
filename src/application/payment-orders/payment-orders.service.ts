import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { FeesService } from '../fees/fees.service';
import { PsavService } from '../psav/psav.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { BridgeApiClient } from '../bridge/bridge-api.client';
import { ClientBankAccountsService } from '../client-bank-accounts/client-bank-accounts.service';
import { OrderReviewService } from './order-review.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/notifications.dto';
import { OrdersGateway } from '../orders/orders.gateway';
import { EmailService } from '../email/email.service';
import {
  CreateInterbankOrderDto,
  InterbankFlowType,
} from './dto/create-interbank-order.dto';
import {
  CreateWalletRampOrderDto,
  WalletRampFlowType,
} from './dto/create-wallet-ramp-order.dto';
import { ConfirmDepositDto } from './dto/confirm-deposit.dto';
import {
  ApproveOrderDto,
  MarkSentDto,
  CompleteOrderDto,
  FailOrderDto,
} from './dto/admin-order-action.dto';
import { ALLOWED_NETWORKS } from '../../common/constants/guira-crypto-config.constants';
import {
  isValidOnRampSourceForDest,
  getMinAmountByDest,
  isValidFiatBoDestination,
  isValidOffRampRoute,
  getOffRampMinAmount,
  resolveFiatBoPsavMatch,
  resolvePsavCryptoSource,
  FIAT_BO_OFF_RAMP_SOURCE_CURRENCIES,
} from '../../common/constants/bridge-route-catalog.constants';
import {
  isValidTransferRoute,
  getTransferMinAmount,
} from '../../common/constants/transfer-route-catalog.constants';
import {
  GOVERNED_FLOWS,
  isGovernedFlow,
  resolveDefaultFlows,
} from '../../common/constants/flow-access.constants';

function buildDateRange(
  year: number,
  month?: number,
): { dateFrom: string; dateTo: string } {
  if (month && month >= 1 && month <= 12) {
    const dateFrom = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const dateTo = (
      month === 12
        ? new Date(Date.UTC(year + 1, 0, 1))
        : new Date(Date.UTC(year, month, 1))
    ).toISOString();
    return { dateFrom, dateTo };
  }
  return {
    dateFrom: new Date(Date.UTC(year, 0, 1)).toISOString(),
    dateTo: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
  };
}

@Injectable()
export class PaymentOrdersService {
  private readonly logger = new Logger(PaymentOrdersService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly feesService: FeesService,
    private readonly psavService: PsavService,
    private readonly exchangeRatesService: ExchangeRatesService,
    private readonly bridgeApi: BridgeApiClient,
    private readonly bankAccountsService: ClientBankAccountsService,
    private readonly orderReviewService: OrderReviewService,
    private readonly notificationsService: NotificationsService,
    private readonly ordersGateway: OrdersGateway,
    private readonly emailService: EmailService,
  ) {}

  private async getActorRole(actorId: string): Promise<string> {
    const { data } = await this.supabase
      .from('profiles')
      .select('role')
      .eq('id', actorId)
      .single();
    return data?.role ?? 'unknown';
  }

  /**
   * Envía el correo de notificación cuando una orden ("expediente") llega a un
   * estado final (completed/failed). Fire-and-forget: nunca lanza, solo loggea.
   */
  private async notifyOrderFinalStatusEmail(
    order: {
      id: string;
      user_id: string;
      amount: number | string | null;
      currency: string | null;
      deposit_reference_code?: string | null;
    },
    status: 'completed' | 'failed',
  ): Promise<void> {
    try {
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', order.user_id)
        .maybeSingle();

      if (!profile?.email) return;

      const details = {
        amount: order.amount ?? 0,
        currency: (order.currency ?? '').toUpperCase(),
        reference: order.deposit_reference_code ?? order.id,
      };
      const recipient = {
        email: profile.email,
        name: profile.full_name ?? undefined,
      };

      if (status === 'completed') {
        await this.emailService.sendPaymentOrderCompletedEmail(
          recipient,
          details,
        );
      } else {
        await this.emailService.sendPaymentOrderFailedEmail(recipient, details);
      }
    } catch (err) {
      this.logger.error(
        `Error enviando email de orden ${status} (${order.id}): ${(err as Error).message}`,
      );
    }
  }

  private parseLiquidationFeePercent(
    value: unknown,
    bridgeLiquidationAddressId: string,
  ): number {
    if (value === null || value === undefined || value === '') {
      throw new BadRequestException(
        `La liquidation address "${bridgeLiquidationAddressId}" no tiene developer_fee_percent explícito. Actualízala en Bridge antes de crear expedientes para evitar discrepancias contables.`,
      );
    }

    const percent =
      typeof value === 'number' ? value : parseFloat(String(value));

    if (!Number.isFinite(percent) || percent < 0 || percent >= 100) {
      throw new BadRequestException(
        `La liquidation address "${bridgeLiquidationAddressId}" tiene developer_fee_percent inválido: ${String(value)}.`,
      );
    }

    return percent;
  }

  private calculateFeeFromLiquidationAddress(
    amount: number,
    developerFeePercent: number,
  ): { fee_amount: number; net_amount: number } {
    const amountCents = Math.round(amount * 100);
    const feeCents = Math.round((amountCents * developerFeePercent) / 100);
    return {
      fee_amount: feeCents / 100,
      net_amount: (amountCents - feeCents) / 100,
    };
  }

  private generateDepositReferenceCode(): string {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    const rand = crypto.randomInt(100000, 1000000);
    return `G-${dd}${mm}${yyyy}-${rand}`;
  }

  // ═══════════════════════════════════════════════
  //  RATE LIMITS & VALIDATION
  // ═══════════════════════════════════════════════

  private async assertCurrencyActive(currency: string): Promise<void> {
    const { data } = await this.supabase
      .from('currency_settings')
      .select('is_active')
      .eq('currency', currency.toLowerCase())
      .single();

    if (!data || !data.is_active) {
      throw new BadRequestException(
        `La divisa ${currency.toUpperCase()} no está habilitada en este momento.`,
      );
    }
  }

  private async validateRateLimit(userId: string): Promise<void> {
    const { data: setting } = await this.supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'MAX_PAYMENT_ORDERS_PER_HOUR')
      .single();

    const maxPerHour = parseInt(setting?.value ?? '5', 10);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { count } = await this.supabase
      .from('payment_orders')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', oneHourAgo);

    if ((count ?? 0) >= maxPerHour) {
      throw new BadRequestException(
        `Has excedido el límite de ${maxPerHour} órdenes por hora`,
      );
    }
  }

  // Límites globales desde app_settings — clave específica por servicio
  private async getGlobalLimits(
    flowType: string,
  ): Promise<{ flow_type: string; min_usd: number; max_usd: number }> {
    const serviceKey = flowType.toUpperCase();

    const { data: rows } = await this.supabase
      .from('app_settings')
      .select('key, value')
      .in('key', [`MIN_${serviceKey}_USD`, `MAX_${serviceKey}_USD`]);

    const map = Object.fromEntries((rows ?? []).map((r) => [r.key, r.value]));

    const min = parseFloat(map[`MIN_${serviceKey}_USD`] ?? '0');
    const max = parseFloat(map[`MAX_${serviceKey}_USD`] ?? '999999');

    return { flow_type: flowType, min_usd: min, max_usd: max };
  }

  // Override activo para un usuario: valid_from ≤ hoy ≤ valid_until (o null)
  private async getActiveLimitOverride(
    userId: string,
    flowType: string,
  ): Promise<{ min_usd: number | null; max_usd: number | null } | null> {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await this.supabase
      .from('customer_limit_overrides')
      .select('min_usd, max_usd')
      .eq('user_id', userId)
      .eq('flow_type', flowType)
      .eq('is_active', true)
      .lte('valid_from', today)
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .maybeSingle();
    return data ?? null;
  }

  // Límites efectivos: override personal → global por servicio → hardcoded
  async getPaymentLimits(
    flowType: string,
    userId?: string,
  ): Promise<{ flow_type: string; min_usd: number; max_usd: number }> {
    const global = await this.getGlobalLimits(flowType);

    if (userId) {
      const override = await this.getActiveLimitOverride(userId, flowType);
      if (override) {
        return {
          flow_type: flowType,
          min_usd: override.min_usd ?? global.min_usd,
          max_usd: override.max_usd ?? global.max_usd,
        };
      }
    }

    return global;
  }

  async getAllPaymentLimits(): Promise<
    Array<{ key: string; value: number; description: string }>
  > {
    const { data, error } = await this.supabase
      .from('app_settings')
      .select('key, value, description')
      .or(
        [
          'MIN_BOLIVIA_TO_WORLD_USD',
          'MAX_BOLIVIA_TO_WORLD_USD',
          'MIN_BOLIVIA_TO_WALLET_USD',
          'MAX_BOLIVIA_TO_WALLET_USD',
          'MIN_WALLET_TO_WALLET_USD',
          'MAX_WALLET_TO_WALLET_USD',
          'MIN_WORLD_TO_BOLIVIA_USD',
          'MAX_WORLD_TO_BOLIVIA_USD',
          'MIN_FIAT_BO_TO_BRIDGE_WALLET_USD',
          'MAX_FIAT_BO_TO_BRIDGE_WALLET_USD',
          'MIN_CRYPTO_TO_BRIDGE_WALLET_USD',
          'MAX_CRYPTO_TO_BRIDGE_WALLET_USD',
          'MIN_BRIDGE_WALLET_TO_FIAT_BO_USD',
          'MAX_BRIDGE_WALLET_TO_FIAT_BO_USD',
          'MIN_BRIDGE_WALLET_TO_CRYPTO_USD',
          'MAX_BRIDGE_WALLET_TO_CRYPTO_USD',
          'MIN_BRIDGE_WALLET_TO_FIAT_US_USD',
          'MAX_BRIDGE_WALLET_TO_FIAT_US_USD',
        ]
          .map((k) => `key.eq.${k}`)
          .join(','),
      )
      .order('key');

    if (error) throwDbError(error);

    return (data ?? []).map((r) => ({
      key: r.key,
      value: parseFloat(r.value),
      description: r.description ?? '',
    }));
  }

  async updatePaymentLimit(
    key: string,
    value: number,
  ): Promise<{ key: string; value: number }> {
    const { error } = await this.supabase
      .from('app_settings')
      .update({ value: String(value) })
      .eq('key', key);

    if (error) throwDbError(error);
    return { key, value };
  }

  private async checkAmountLimits(
    amount: number,
    flowType: string,
    currency?: string,
    userId?: string,
  ): Promise<{
    amountUsd: number;
    min: number;
    max: number;
    exceeded: boolean;
  }> {
    const { min_usd: min, max_usd: max } = await this.getPaymentLimits(
      flowType,
      userId,
    );

    // BOB y EURC se convierten con el tipo de cambio actual.
    // Stablecoins USD (USDC, USDT, USDB, PYUSD) se tratan como 1:1 USD.
    // EURC es 1:1 EUR, no USD — se convierte explícitamente.
    let amountUsd = amount;
    const upperCurrency = (currency ?? 'USD').toUpperCase();

    if (upperCurrency === 'BOB') {
      const rateData = await this.exchangeRatesService.getRate('BOB_USD');
      amountUsd = parseFloat((amount / rateData.effective_rate).toFixed(2));
    } else if (upperCurrency === 'EURC') {
      const rateData = await this.exchangeRatesService.getRate('BOB_EUR');
      if (!rateData.bridge_sell_rate) {
        throw new BadRequestException('Tipo de cambio EUR/USD no disponible.');
      }
      amountUsd = parseFloat((amount / rateData.bridge_sell_rate).toFixed(2));
    }

    if (amountUsd < min) {
      throw new BadRequestException(
        `El monto mínimo es $${min} USD (tu monto equivale a ~$${amountUsd} USD)`,
      );
    }

    return { amountUsd, min, max, exceeded: amountUsd > max };
  }

  private async getUserWallet(userId: string, walletId?: string) {
    const query = this.supabase
      .from('wallets')
      .select('id, network, address, provider_wallet_id')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (walletId) {
      query.eq('id', walletId);
    }

    const { data, error } = await query.limit(1).single();

    if (error || !data) {
      throw new NotFoundException('Wallet no encontrada para este usuario');
    }
    if (!data.provider_wallet_id) {
      throw new BadRequestException(
        'La wallet seleccionada no está vinculada a Bridge. Por favor inicializa tus wallets primero.',
      );
    }
    return data;
  }

  // ═══════════════════════════════════════════════
  //  INTERBANK ORDERS (CATEGORY: interbank)
  // ═══════════════════════════════════════════════

  async createInterbankOrder(
    userId: string,
    dto: CreateInterbankOrderDto,
    reviewContext?: { clientReason: string; documentUrl?: string },
  ) {
    await this.validateRateLimit(userId);
    await this.assertFlowEnabled(userId, dto.flow_type);

    // Resolver la moneda de entrada para normalizar límites a USD
    let inputCurrency = 'USD';
    switch (dto.flow_type) {
      case InterbankFlowType.BOLIVIA_TO_WORLD:
      case InterbankFlowType.BOLIVIA_TO_WALLET:
        inputCurrency = 'BOB';
        break;
      case InterbankFlowType.WALLET_TO_WALLET:
        inputCurrency = dto.source_currency?.toUpperCase() ?? 'USDC';
        break;
      // WORLD_TO_BOLIVIA, WORLD_TO_WALLET → USD (default)
    }

    if (dto.amount != null) {
      const limitCheck = await this.checkAmountLimits(
        dto.amount,
        dto.flow_type,
        inputCurrency,
        userId,
      );

      if (limitCheck.exceeded) {
        if (!reviewContext?.clientReason) {
          throw new BadRequestException(
            `El monto excede el límite máximo de $${limitCheck.max} USD. Envía una solicitud de revisión con el motivo de la operación.`,
          );
        }
        const review = await this.orderReviewService.createReviewRequest({
          userId,
          flowType: dto.flow_type,
          amount: dto.amount,
          currency: inputCurrency,
          amountUsdEquiv: limitCheck.amountUsd,
          limitUsd: limitCheck.max,
          excessUsd: parseFloat(
            (limitCheck.amountUsd - limitCheck.max).toFixed(2),
          ),
          requestPayload: dto as unknown as Record<string, unknown>,
          clientReason: reviewContext.clientReason,
          documentUrl: reviewContext.documentUrl,
        });
        return { _type: 'review_request' as const, review };
      }
    }

    let interbankOrder: any;
    switch (dto.flow_type) {
      case InterbankFlowType.BOLIVIA_TO_WORLD:
        interbankOrder = await this.createBoliviaToWorld(userId, dto);
        break;
      case InterbankFlowType.WALLET_TO_WALLET:
        interbankOrder = await this.createWalletToWallet(userId, dto);
        break;
      case InterbankFlowType.BOLIVIA_TO_WALLET:
        interbankOrder = await this.createBoliviaToWallet(userId, dto);
        break;
      case InterbankFlowType.WORLD_TO_BOLIVIA:
        interbankOrder = await this.createWorldToBolivia(userId, dto);
        break;
      case InterbankFlowType.WORLD_TO_WALLET:
        interbankOrder = await this.createWorldToWallet(userId, dto);
        break;
      default:
        throw new BadRequestException(`Flujo no soportado: ${dto.flow_type}`);
    }

    // Audit trail de creación de orden (best-effort)
    void this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'client',
      action: 'CREATE_PAYMENT_ORDER',
      table_name: 'payment_orders',
      record_id: interbankOrder.id,
      new_values: {
        flow_type: interbankOrder.flow_type,
        amount: interbankOrder.amount,
        currency: interbankOrder.currency,
        status: interbankOrder.status,
      },
      source: 'api',
    });

    // Notificar al staff que hay una nueva orden
    this.ordersGateway.emitOrderCreated({
      id: interbankOrder.id,
      user_id: interbankOrder.user_id,
      flow_type: interbankOrder.flow_type,
      flow_category: interbankOrder.flow_category ?? 'interbank',
      amount: parseFloat(interbankOrder.amount),
      currency: interbankOrder.currency,
      status: interbankOrder.status,
      created_at: interbankOrder.created_at,
    });

    return interbankOrder;
  }

  /**
   * 1.1 Bolivia → Mundo (PSAV completo)
   * BOB → cuenta PSAV BO → PSAV convierte → envía a external_account destino
   */
  private async createBoliviaToWorld(
    userId: string,
    dto: CreateInterbankOrderDto,
  ) {
    // Validar external_account existe y pertenece al usuario
    const { data: extAccount, error: extErr } = await this.supabase
      .from('bridge_external_accounts')
      .select('*')
      .eq('id', dto.external_account_id)
      .eq('user_id', userId)
      .single();

    if (extErr || !extAccount) {
      throw new NotFoundException('Cuenta externa de destino no encontrada');
    }

    // Bloquear si ya existe un expediente activo hacia la misma divisa destino
    const destinationCurrency = dto.destination_currency ?? extAccount.currency;
    await this.assertNoConflictingBoliviaToWorldOrder(
      userId,
      destinationCurrency,
    );

    // Obtener el número completo del JSON bank_details en la tabla 'suppliers'
    // y validar que el proveedor tenga una liquidation address configurada
    const { data: supplier } = await this.supabase
      .from('suppliers')
      .select('bank_details, bridge_liquidation_address_id')
      .eq('bridge_external_account_id', dto.external_account_id)
      .single();

    if (!supplier?.bridge_liquidation_address_id) {
      throw new BadRequestException(
        'El proveedor seleccionado no tiene una liquidation address configurada en Bridge. ' +
          'Contacte al administrador para configurarla antes de crear la orden.',
      );
    }

    const { data: liquidationAddressForFee } = await this.supabase
      .from('bridge_liquidation_addresses')
      .select('bridge_liquidation_address_id, developer_fee_percent')
      .eq('user_id', userId)
      .eq(
        'bridge_liquidation_address_id',
        supplier.bridge_liquidation_address_id,
      )
      .single();

    if (!liquidationAddressForFee) {
      throw new BadRequestException(
        `Liquidation address "${supplier.bridge_liquidation_address_id}" no encontrada en la base de datos.`,
      );
    }

    const liquidationFeePercent = this.parseLiquidationFeePercent(
      liquidationAddressForFee.developer_fee_percent,
      liquidationAddressForFee.bridge_liquidation_address_id,
    );

    const fullAccountNumber =
      supplier?.bank_details?.account_number ??
      extAccount.account_last_4 ??
      extAccount.iban ??
      extAccount.swift_bic;

    // Obtener cuenta PSAV para depósito en BOB
    const psavAccount = await this.psavService.getDepositAccount(
      'bank_bo',
      'BOB',
    );
    const depositInstructions =
      this.psavService.formatDepositInstructions(psavAccount);

    // El fee de este flujo debe respetar el porcentaje congelado en la
    // liquidation address, no el fees_config global actual.
    const { fee_amount, net_amount } = this.calculateFeeFromLiquidationAddress(
      dto.amount!,
      liquidationFeePercent,
    );

    // Obtener tipo de cambio para la divisa destino real (BOB_EUR, BOB_USD, BOB_MXN…).
    // USDC/USDT se anclan a USD. Fallback a BOB_USD si el par aún no está configurado.
    const destCurrNorm = destinationCurrency
      .toUpperCase()
      .replace(/^USDC$|^USDT$/, 'USD');
    const rateData = await this.exchangeRatesService
      .getRate(`BOB_${destCurrNorm}`)
      .catch(() => this.exchangeRatesService.getRate('BOB_USD'));
    // Tipo de cambio congelado por el cliente en la revisión (Step 4). Si llegó,
    // prevalece sobre el rate actual del servidor para honrar lo que el cliente aceptó.
    const appliedRate =
      dto.exchange_rate_applied && dto.exchange_rate_applied > 0
        ? dto.exchange_rate_applied
        : rateData.effective_rate;

    // Crear orden
    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        flow_type: 'bolivia_to_world',
        flow_category: 'interbank',
        requires_psav: true,
        amount: dto.amount,
        currency: 'BOB',
        fee_amount,
        net_amount,
        fee_source: 'liquidation_address',
        bridge_liquidation_address_id:
          liquidationAddressForFee.bridge_liquidation_address_id,
        bridge_liquidation_fee_percent: liquidationFeePercent,
        destination_type: 'external_account',
        destination_currency: destinationCurrency,
        external_account_id: dto.external_account_id,
        supplier_id: dto.supplier_id ?? null,
        destination_bank_name: extAccount.bank_name,
        destination_account_holder:
          extAccount.account_name ??
          extAccount.first_name ??
          extAccount.business_name,
        destination_account_number: fullAccountNumber,
        exchange_rate_applied: appliedRate,
        amount_destination: parseFloat((net_amount / appliedRate).toFixed(2)),
        psav_deposit_instructions: depositInstructions,
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        notes: dto.notes,
        deposit_reference_code: this.generateDepositReferenceCode(),
        status: 'waiting_deposit',
      })
      .select()
      .single();

    if (error) throwDbError(error);

    this.logger.log(
      `📋 Orden bolivia_to_world creada: ${order.id} — $${dto.amount} BOB`,
    );
    return order;
  }

  /**
   * 1.2 Wallet → Wallet (Bridge Transfer, sin PSAV)
   * Crypto ad-hoc → Crypto del proveedor vía Bridge Transfer API.
   * El destino se resuelve desde el supplier seleccionado.
   */
  private async createWalletToWallet(
    userId: string,
    dto: CreateInterbankOrderDto,
  ) {
    // ── 1. Resolver destino desde el proveedor ──
    const { data: supplier, error: supplierErr } = await this.supabase
      .from('suppliers')
      .select('id, name, bank_details, payment_rail')
      .eq('id', dto.supplier_id)
      .eq('user_id', userId)
      .single();

    if (supplierErr || !supplier) {
      throw new NotFoundException(
        'Proveedor no encontrado o no pertenece al usuario.',
      );
    }

    const destAddress = supplier.bank_details?.wallet_address as
      | string
      | undefined;
    const destNetwork = supplier.bank_details?.wallet_network as
      | string
      | undefined;
    const destCurrency = (
      (supplier.bank_details?.wallet_currency as string | undefined) ??
      dto.destination_currency
    )?.toLowerCase();

    if (!destAddress || !destNetwork || !destCurrency) {
      throw new BadRequestException(
        'El proveedor seleccionado no tiene dirección, red o moneda crypto configurada. ' +
          'Complete los datos del proveedor antes de crear la orden.',
      );
    }

    // ── 1b. Verificar que la moneda fuente esté habilitada en currency_settings ──
    await this.assertCurrencyActive(dto.source_currency!);

    // ── 2. Validar ruta Bridge (src_net/src_cur → dst_net/dst_cur) ──
    if (
      !isValidTransferRoute(
        dto.source_network!,
        dto.source_currency!,
        destNetwork,
        destCurrency,
      )
    ) {
      throw new BadRequestException(
        `La combinación de origen ${dto.source_currency?.toUpperCase()}/${dto.source_network} ` +
          `hacia ${destCurrency.toUpperCase()}/${destNetwork} no es soportada por Bridge. ` +
          `Selecciona una red y moneda de origen válidas para el destino del proveedor.`,
      );
    }

    // ── 3. Validar monto mínimo de la ruta (solo si el cliente especificó un monto) ──
    const amount = dto.amount ?? 0;
    const minAmount = getTransferMinAmount(
      dto.source_network!,
      dto.source_currency!,
      destNetwork,
      destCurrency,
    );
    if (amount > 0 && amount < minAmount) {
      throw new BadRequestException(
        `El monto mínimo para esta ruta (${dto.source_currency?.toUpperCase()}/${dto.source_network} → ` +
          `${destCurrency.toUpperCase()}/${destNetwork}) es ${minAmount} ${dto.source_currency?.toUpperCase()}.`,
      );
    }

    // Bloqueo preventivo: evitar colision de liquidation address.
    await this.assertNoConflictingBridgeDepositOrder(
      userId,
      dto.source_currency!,
      dto.source_network!,
    );

    const feePercent = await this.feesService.getFeePercent(
      userId,
      'interbank_w2w',
      'bridge',
    );

    // fee_amount / net_amount: se calculan solo si hay monto definido.
    // Para depósitos flexibles (amount=0) se rellenan desde el receipt del webhook al completarse.
    const { fee_amount, net_amount } =
      amount > 0
        ? await this.feesService.calculateFee(
            userId,
            'interbank_w2w',
            'bridge',
            amount,
          )
        : { fee_amount: 0, net_amount: 0 };

    // ── 4. Crear orden ──
    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        flow_type: 'wallet_to_wallet',
        flow_category: 'interbank',
        requires_psav: false,
        amount: amount,
        currency: dto.source_currency?.toUpperCase(),
        fee_amount,
        net_amount,
        source_address: dto.source_address,
        source_network: dto.source_network,
        source_currency: dto.source_currency?.toUpperCase(),
        destination_type: 'crypto_address',
        destination_address: destAddress,
        destination_network: destNetwork,
        destination_currency: destCurrency.toUpperCase(),
        exchange_rate_applied: 1,
        amount_destination: net_amount,
        supplier_id: dto.supplier_id,
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        notes: dto.notes,
        status: 'created',
      })
      .select()
      .single();

    if (error) throwDbError(error);

    // ── 5. Ejecutar transfer vía Bridge API ──
    try {
      const { data: profile } = await this.supabase
        .from('profiles')
        .select('bridge_customer_id')
        .eq('id', userId)
        .single();

      if (!profile?.bridge_customer_id) {
        throw new Error(
          'El usuario no tiene bridge_customer_id asignado. Debe completar el KYC.',
        );
      }

      const idempotencyKey = `po_w2w_${order.id}`;
      const bridgeResult = await this.bridgeApi.post<Record<string, unknown>>(
        '/v0/transfers',
        {
          on_behalf_of: profile.bridge_customer_id,
          source: {
            payment_rail: dto.source_network?.toLowerCase(),
            currency: dto.source_currency?.toLowerCase(),
            // Sin from_address → Bridge acepta fondos de cualquier dirección
          },
          destination: {
            payment_rail: destNetwork.toLowerCase(),
            currency: destCurrency.toLowerCase(),
            to_address: destAddress,
          },
          // Sin amount → Bridge acepta cualquier monto (flexible_amount)
          developer_fee_percent: feePercent,
          client_reference_id: order.id,
          features: {
            flexible_amount: true,
            allow_any_from_address: true,
          },
        },
        idempotencyKey,
      );

      const transferId = (bridgeResult?.id ?? null) as string | null;
      const sourceDepositInstructions =
        bridgeResult?.source_deposit_instructions ?? null;

      // ── Crear registro bridge_transfers (requerido para vincular webhooks) ──
      await this.supabase.from('bridge_transfers').insert({
        user_id: userId,
        bridge_transfer_id: transferId,
        amount: amount,
        net_amount,
        bridge_state: (bridgeResult?.state as string) ?? 'awaiting_funds',
        status: 'pending',
        source_payment_rail: dto.source_network,
        source_currency: dto.source_currency?.toLowerCase(),
        developer_fee_percent: feePercent,
        destination_payment_rail: destNetwork,
        destination_currency: destCurrency.toUpperCase(),
        bridge_raw_response: bridgeResult,
      });

      await this.supabase
        .from('payment_orders')
        .update({
          status: 'waiting_deposit',
          bridge_transfer_id: transferId,
          bridge_source_deposit_instructions: sourceDepositInstructions,
        })
        .eq('id', order.id);

      order.status = 'waiting_deposit';
      order.bridge_transfer_id = transferId;
      order.bridge_source_deposit_instructions = sourceDepositInstructions;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'failed',
          failure_reason: `Bridge Transfer falló: ${message}`,
        })
        .eq('id', order.id);

      void this.notifyOrderFinalStatusEmail(order, 'failed');

      throw new BadRequestException(`Error al ejecutar transfer: ${message}`);
    }

    this.logger.log(
      `📋 Orden wallet_to_wallet creada: ${order.id} — ${amount > 0 ? amount : 'flexible'} ${dto.source_currency} → ${destCurrency.toUpperCase()}/${destNetwork} (supplier: ${supplier.name}, fee: ${feePercent}%)`,
    );
    return { ...order, fee_percent: parseFloat(feePercent) };
  }

  /**
   * 1.3 Bolivia → Wallet (PSAV a crypto externa)
   * BOB → cuenta PSAV BO → PSAV compra crypto → envía a wallet externa
   */
  private async createBoliviaToWallet(
    userId: string,
    dto: CreateInterbankOrderDto,
  ) {
    // Validar que el proveedor tenga liquidation address configurada
    const { data: supplier } = await this.supabase
      .from('suppliers')
      .select('bank_details, bridge_liquidation_address_id')
      .eq('id', dto.supplier_id)
      .single();

    if (!supplier?.bridge_liquidation_address_id) {
      throw new BadRequestException(
        'El proveedor seleccionado no tiene una liquidation address configurada en Bridge. ' +
          'Contacte al administrador para configurarla antes de crear la orden.',
      );
    }

    const { data: liquidationAddressForFee } = await this.supabase
      .from('bridge_liquidation_addresses')
      .select('bridge_liquidation_address_id, developer_fee_percent, currency')
      .eq('user_id', userId)
      .eq(
        'bridge_liquidation_address_id',
        supplier.bridge_liquidation_address_id,
      )
      .single();

    if (!liquidationAddressForFee) {
      throw new BadRequestException(
        `Liquidation address "${supplier.bridge_liquidation_address_id}" no encontrada en la base de datos.`,
      );
    }

    const liquidationFeePercent = this.parseLiquidationFeePercent(
      liquidationAddressForFee.developer_fee_percent,
      liquidationAddressForFee.bridge_liquidation_address_id,
    );

    const psavAccount = await this.psavService.getDepositAccount(
      'bank_bo',
      'BOB',
    );
    const depositInstructions =
      this.psavService.formatDepositInstructions(psavAccount);

    const { fee_amount, net_amount } = this.calculateFeeFromLiquidationAddress(
      dto.amount!,
      liquidationFeePercent,
    );

    const rateData = await this.exchangeRatesService.getRate('BOB_USD');
    // Tipo de cambio congelado por el cliente en la revisión (Step 4). Si llegó,
    // prevalece sobre el rate actual del servidor para honrar lo que el cliente aceptó.
    const appliedRate =
      dto.exchange_rate_applied && dto.exchange_rate_applied > 0
        ? dto.exchange_rate_applied
        : rateData.effective_rate;

    // La divisa destino es el token real de la liquidation address (USDC/USDT...),
    // no la que envía el cliente. El formulario puede mandar 'USD' por defecto, pero
    // la LA es la fuente de verdad: el dinero llega exactamente en su `currency`.
    const destinationCurrency = (
      liquidationAddressForFee.currency || dto.destination_currency
    )?.toUpperCase();

    if (!destinationCurrency) {
      throw new BadRequestException(
        'No se pudo resolver la divisa destino para bolivia_to_wallet. La liquidation ' +
          'address no tiene `currency` y el cliente no especificó destination_currency.',
      );
    }

    // Bloquear si ya existe un expediente activo hacia la misma divisa destino
    await this.assertNoConflictingPsavOrder(
      userId,
      'bolivia_to_wallet',
      destinationCurrency,
    );

    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        flow_type: 'bolivia_to_wallet',
        flow_category: 'interbank',
        requires_psav: true,
        amount: dto.amount,
        currency: 'BOB',
        fee_amount,
        net_amount,
        fee_source: 'liquidation_address',
        bridge_liquidation_address_id:
          liquidationAddressForFee.bridge_liquidation_address_id,
        bridge_liquidation_fee_percent: liquidationFeePercent,
        destination_type: 'crypto_address',
        destination_address: dto.destination_address,
        destination_network: dto.destination_network,
        destination_currency: destinationCurrency,
        supplier_id: dto.supplier_id ?? null,
        exchange_rate_applied: appliedRate,
        amount_destination: parseFloat((net_amount / appliedRate).toFixed(2)),
        psav_deposit_instructions: depositInstructions,
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        notes: dto.notes,
        deposit_reference_code: this.generateDepositReferenceCode(),
        status: 'waiting_deposit',
      })
      .select()
      .single();

    if (error) throwDbError(error);

    this.logger.log(
      `📋 Orden bolivia_to_wallet creada: ${order.id} — $${dto.amount} BOB`,
    );
    return order;
  }

  /**
   * 1.4 Mundo → Bolivia (Fiat/Crypto externo → cuenta bancaria BO)
   * El cliente envía dinero a Bridge VA o PSAV, luego se deposita en su cuenta bancaria BO
   */
  private async createWorldToBolivia(
    userId: string,
    dto: CreateInterbankOrderDto,
  ) {
    // El destino bancario se obtiene de la cuenta primaria BOB aprobada del
    // cliente (igual que bridge_wallet_to_fiat_bo): no se acepta una cuenta
    // arbitraria del payload, así se garantiza que el depósito siempre llegue
    // a la cuenta que el cliente registró y verificó en su perfil.
    const bankAccount =
      await this.bankAccountsService.getApprovedAccountForWithdrawal(userId);

    // Obtener cuenta PSAV para depósito en USD (el usuario deposita USD)
    const psavAccount = await this.psavService.getDepositAccount(
      'bank_us',
      'USD',
    );
    const depositInstructions =
      this.psavService.formatDepositInstructions(psavAccount);

    const { fee_amount, net_amount } = await this.feesService.calculateFee(
      userId,
      'interbank_bo_in',
      'psav',
      dto.amount!,
    );

    const rateData = await this.exchangeRatesService.getRate('USD_BOB');
    // Tipo de cambio congelado por el cliente en la revisión (Step 4). Si llegó,
    // prevalece sobre el rate actual del servidor para honrar lo que el cliente aceptó.
    const appliedRate =
      dto.exchange_rate_applied && dto.exchange_rate_applied > 0
        ? dto.exchange_rate_applied
        : rateData.effective_rate;

    // Bloquear si ya existe un expediente world_to_bolivia activo
    await this.assertNoConflictingPsavOrder(userId, 'world_to_bolivia', 'BOB');

    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        flow_type: 'world_to_bolivia',
        flow_category: 'interbank',
        requires_psav: true,
        amount: dto.amount,
        currency: 'USD', // world_to_bolivia: el usuario deposita USD
        fee_amount,
        net_amount,
        destination_type: 'bank_bo',
        destination_currency: 'BOB',
        destination_bank_name: bankAccount.bank_name,
        destination_account_number: bankAccount.account_number,
        destination_account_holder: bankAccount.account_holder,
        client_bank_account_id: bankAccount.id,
        destination_qr_url: dto.destination_qr_url,
        supplier_id: dto.supplier_id ?? null,
        exchange_rate_applied: appliedRate,
        amount_destination: parseFloat((net_amount * appliedRate).toFixed(2)),
        psav_deposit_instructions: depositInstructions,
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        notes: dto.notes,
        deposit_reference_code: this.generateDepositReferenceCode(),
        status: 'waiting_deposit',
      })
      .select()
      .single();

    if (error) throwDbError(error);

    this.logger.log(
      `📋 Orden world_to_bolivia creada: ${order.id} — $${dto.amount} USD→BOB`,
    );
    return order;
  }

  /**
   * 1.5 Mundo → Wallet (Wire/ACH/SEPA → Wallet Bridge)
   * El cliente envía fiat por Virtual Account → fondea el wallet Bridge
   */
  private async createWorldToWallet(
    userId: string,
    dto: CreateInterbankOrderDto,
  ) {
    // Verificar o Inferir VA
    let vaId = dto.virtual_account_id;
    let vaData: any;
    if (!vaId) {
      const { data: va } = await this.supabase
        .from('bridge_virtual_accounts')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (!va) {
        throw new NotFoundException(
          'Virtual Account no encontrada para el usuario',
        );
      }
      vaId = va.id;
      vaData = va;
    } else {
      const { data: va } = await this.supabase
        .from('bridge_virtual_accounts')
        .select('*')
        .eq('id', vaId)
        .eq('user_id', userId)
        .single();

      if (!va)
        throw new NotFoundException('Virtual Account provista no encontrada');
      vaData = va;
    }

    const wallet = await this.getUserWallet(userId);

    const { fee_amount, net_amount } = await this.feesService.calculateFee(
      userId,
      'ramp_on_fiat_us',
      'bridge',
      dto.amount!,
    );

    const depositInstructions = {
      type: 'bank',
      label: 'Tu Virtual Account',
      bank_name: vaData.bank_name || 'Banco de VA',
      account_holder:
        vaData.account_holder_name || vaData.beneficiary_name || 'Guira',
      account_number: `ACC: ${vaData.account_number || ''} | Routing: ${vaData.routing_number || ''}`,
      currency: vaData.destination_currency || 'USD',
    };

    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        wallet_id: wallet.id,
        flow_type: 'world_to_wallet',
        flow_category: 'interbank',
        requires_psav: false,
        amount: dto.amount,
        currency: 'USD',
        fee_amount,
        net_amount,
        destination_type: 'bridge_wallet',
        destination_currency: dto.destination_currency ?? 'usdc',
        supplier_id: dto.supplier_id ?? null,
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        notes: dto.notes,
        psav_deposit_instructions: depositInstructions,
        status: 'waiting_deposit',
      })
      .select()
      .single();

    if (error) throwDbError(error);

    this.logger.log(
      `📋 Orden world_to_wallet creada: ${order.id} — $${dto.amount} USD`,
    );
    return order;
  }

  // ═══════════════════════════════════════════════
  //  COMPATIBILIDAD: BLOQUEO EXCLUSIVO DESACTIVADO
  // ═══════════════════════════════════════════════

  /**
   * Endpoint legado para clientes antiguos.
   * El bloqueo general entre los 5 servicios fue desactivado.
   */
  async getActiveExclusiveOrder(userId: string): Promise<{
    has_active: boolean;
    active_order?: {
      id: string;
      flow_type: string;
      status: string;
      created_at: string;
    };
  }> {
    void userId;
    return { has_active: false };
  }

  // ═══════════════════════════════════════════════
  //  BLOQUEO PREVENTIVO: COLISIÓN DE LIQUIDATION ADDRESS
  // ═══════════════════════════════════════════════

  /**
   * Verifica que el usuario no tenga ya un expediente bolivia_to_world
   * activo hacia la misma divisa de destino.
   *
   * Se permite un solo expediente activo por divisa: un expediente en USD
   * no bloquea crear uno en BRL o MXN, pero sí bloquea un segundo en USD.
   *
   * Estados considerados "activos": waiting_deposit, deposit_received,
   * processing. Los estados terminales (completed, failed, cancelled) no
   * bloquean.
   */
  private async assertNoConflictingBoliviaToWorldOrder(
    userId: string,
    destinationCurrency: string,
  ): Promise<void> {
    const normalizedCurrency = destinationCurrency.toUpperCase();

    const { data: conflicting } = await this.supabase
      .from('payment_orders')
      .select('id, destination_currency, status, created_at')
      .eq('user_id', userId)
      .eq('flow_type', 'bolivia_to_world')
      .eq('destination_currency', normalizedCurrency)
      .in('status', ['waiting_deposit', 'deposit_received', 'processing'])
      .limit(1)
      .maybeSingle();

    if (conflicting) {
      const shortId = conflicting.id.slice(0, 8);
      throw new ConflictException({
        code: 'ACTIVE_ORDER_CONFLICT',
        active_order_id: conflicting.id,
        message:
          `Ya tienes un expediente activo (${shortId}) hacia ${normalizedCurrency}. ` +
          `Debes completar o cancelar ese expediente antes de crear uno nuevo ` +
          `hacia la misma divisa.`,
      });
    }
  }

  /**
   * Verifica que el usuario no tenga otra orden on-ramp activa que
   * compartiría la misma liquidation address en Bridge.
   *
   * Bridge reutiliza la dirección de depósito para el mismo customer +
   * moneda + red.  Si hay dos transfers activas (awaiting_funds) con
   * la misma dirección, Bridge puede asignar el depósito a la transfer
   * equivocada.
   *
   * Cubre TODAS las monedas (USDC, USDT, EURC, PYUSD, USDB) y redes
   * (ethereum, solana, polygon, tron, stellar, base, etc.).
   */
  private async assertNoConflictingBridgeDepositOrder(
    userId: string,
    sourceCurrency: string,
    sourceNetwork: string,
  ): Promise<void> {
    const normalizedCurrency = sourceCurrency.toUpperCase();
    const normalizedNetwork = sourceNetwork.toLowerCase();

    const { data: conflicting } = await this.supabase
      .from('payment_orders')
      .select('id, flow_type, created_at')
      .eq('user_id', userId)
      .eq('status', 'waiting_deposit')
      .in('flow_type', [
        'fiat_bo_to_bridge_wallet',
        'crypto_to_bridge_wallet',
        'wallet_to_wallet',
      ])
      .eq('source_network', normalizedNetwork)
      .or(`source_currency.eq.${normalizedCurrency},source_currency.is.null`)
      .not('bridge_transfer_id', 'is', null)
      .limit(1)
      .maybeSingle();

    if (conflicting) {
      const shortId = conflicting.id.slice(0, 8);
      throw new ConflictException(
        `Ya tienes un expediente pendiente de depósito (${shortId}) ` +
          `que utiliza la misma dirección de recepción ` +
          `(${normalizedCurrency} en ${normalizedNetwork}). ` +
          `Completa o cancela ese expediente antes de crear uno nuevo.`,
      );
    }
  }

  /**
   * Bloquea si el usuario ya tiene una orden activa del mismo flow_type
   * hacia la misma divisa destino. Cubre flujos PSAV (on-ramp) que no
   * pasan por Bridge:
   *   - bolivia_to_wallet  (BOB → USDC/USDT en Bridge wallet)
   *   - world_to_bolivia   (USD → BOB, destino siempre BOB)
   *
   * Estados activos: waiting_deposit, deposit_received, processing.
   * Respaldado por partial unique indexes:
   *   idx_po_b2w_active_per_dest_currency
   *   idx_po_w2b_active_per_dest_currency
   */
  private async assertNoConflictingPsavOrder(
    userId: string,
    flowType: string,
    destinationCurrency: string,
  ): Promise<void> {
    const normalized = destinationCurrency.toUpperCase();

    const { data: conflicting } = await this.supabase
      .from('payment_orders')
      .select('id, status, created_at')
      .eq('user_id', userId)
      .eq('flow_type', flowType)
      .eq('destination_currency', normalized)
      .in('status', ['waiting_deposit', 'deposit_received', 'processing'])
      .limit(1)
      .maybeSingle();

    if (conflicting) {
      const shortId = conflicting.id.slice(0, 8);
      throw new ConflictException(
        `Ya tienes un expediente activo (${shortId}) de tipo ${flowType} ` +
          `hacia ${normalized}. Completa o cancela ese expediente antes ` +
          `de crear uno nuevo.`,
      );
    }
  }

  /**
   * Bloquea si el usuario ya tiene un off-ramp activo desde la misma
   * moneda fuente. Cubre:
   *   - bridge_wallet_to_fiat_bo (crypto → BOB vía PSAV)
   *
   * Estados activos: created, processing (off-ramps nunca usan waiting_deposit).
   * Respaldado por idx_po_bw2fbo_active_per_src.
   */
  private async assertNoConflictingOffRampOrder(
    userId: string,
    flowType: string,
    sourceCurrency: string,
  ): Promise<void> {
    const normalized = sourceCurrency.toUpperCase();

    const { data: conflicting } = await this.supabase
      .from('payment_orders')
      .select('id, status, created_at')
      .eq('user_id', userId)
      .eq('flow_type', flowType)
      .eq('source_currency', normalized)
      .in('status', ['created', 'processing'])
      .limit(1)
      .maybeSingle();

    if (conflicting) {
      const shortId = conflicting.id.slice(0, 8);
      throw new ConflictException(
        `Ya tienes un retiro activo (${shortId}) desde ${normalized}. ` +
          `Espera a que se complete o cancélalo antes de crear uno nuevo.`,
      );
    }
  }

  /**
   * Bloquea si el usuario ya tiene un off-ramp crypto activo con la
   * misma moneda fuente hacia la misma red destino. Cubre:
   *   - bridge_wallet_to_crypto
   *
   * Respaldado por idx_po_bw2c_active_per_src_dest.
   */
  private async assertNoConflictingCryptoOffRamp(
    userId: string,
    sourceCurrency: string,
    destinationNetwork: string,
  ): Promise<void> {
    const normCurrency = sourceCurrency.toUpperCase();
    const normNetwork = destinationNetwork.toLowerCase();

    const { data: conflicting } = await this.supabase
      .from('payment_orders')
      .select('id, status, created_at')
      .eq('user_id', userId)
      .eq('flow_type', 'bridge_wallet_to_crypto')
      .eq('source_currency', normCurrency)
      .eq('destination_network', normNetwork)
      .in('status', ['created', 'processing'])
      .limit(1)
      .maybeSingle();

    if (conflicting) {
      const shortId = conflicting.id.slice(0, 8);
      throw new ConflictException(
        `Ya tienes un retiro crypto activo (${shortId}) desde ${normCurrency} ` +
          `hacia la red ${normNetwork}. Espera a que se complete o cancélalo ` +
          `antes de crear uno nuevo.`,
      );
    }
  }

  /**
   * Bloquea si el usuario ya tiene un off-ramp fiat US activo con la
   * misma moneda fuente hacia el mismo proveedor. Cubre:
   *   - bridge_wallet_to_fiat_us
   *
   * Respaldado por idx_po_bw2fus_active_per_src_supplier.
   */
  private async assertNoConflictingFiatUsOffRamp(
    userId: string,
    sourceCurrency: string,
    supplierId: string,
  ): Promise<void> {
    const normCurrency = sourceCurrency.toUpperCase();

    const { data: conflicting } = await this.supabase
      .from('payment_orders')
      .select('id, status, created_at')
      .eq('user_id', userId)
      .eq('flow_type', 'bridge_wallet_to_fiat_us')
      .eq('source_currency', normCurrency)
      .eq('supplier_id', supplierId)
      .in('status', ['created', 'processing'])
      .limit(1)
      .maybeSingle();

    if (conflicting) {
      const shortId = conflicting.id.slice(0, 8);
      throw new ConflictException(
        `Ya tienes un retiro activo (${shortId}) desde ${normCurrency} ` +
          `hacia este proveedor. Espera a que se complete o cancélalo ` +
          `antes de crear uno nuevo.`,
      );
    }
  }

  // ═══════════════════════════════════════════════
  //  WALLET RAMP ORDERS (CATEGORY: wallet_ramp)
  // ═══════════════════════════════════════════════

  async createWalletRampOrder(
    userId: string,
    dto: CreateWalletRampOrderDto,
    reviewContext?: { clientReason: string; documentUrl?: string },
  ) {
    await this.validateRateLimit(userId);
    await this.assertFlowEnabled(userId, dto.flow_type);

    // Validar que la divisa principal del flujo esté habilitada.
    // source_currency tiene prioridad: en flujos de retiro de wallet es el crypto
    // que sale (ej: usdc → usd). destination_currency solo aplica cuando no hay
    // source_currency (ej: fiat_bo_to_bridge_wallet donde llega crypto como destino).
    const currencyToCheck = dto.source_currency ?? dto.destination_currency;
    if (currencyToCheck) {
      await this.assertCurrencyActive(currencyToCheck);
    }

    // Resolver la moneda de entrada para normalizar límites a USD
    let inputCurrency = 'USD';
    switch (dto.flow_type) {
      case WalletRampFlowType.FIAT_BO_TO_BRIDGE_WALLET:
        inputCurrency = 'BOB';
        break;
      case WalletRampFlowType.CRYPTO_TO_BRIDGE_WALLET:
      case WalletRampFlowType.BRIDGE_WALLET_TO_FIAT_BO:
      case WalletRampFlowType.BRIDGE_WALLET_TO_CRYPTO:
      case WalletRampFlowType.BRIDGE_WALLET_TO_FIAT_US:
      case WalletRampFlowType.WALLET_TO_FIAT:
        inputCurrency = dto.source_currency?.toUpperCase() ?? 'USDC';
        break;
    }

    const limitCheck = await this.checkAmountLimits(
      dto.amount,
      dto.flow_type,
      inputCurrency,
      userId,
    );

    if (limitCheck.exceeded) {
      if (!reviewContext?.clientReason) {
        throw new BadRequestException(
          `El monto excede el límite máximo de $${limitCheck.max} USD. Envía una solicitud de revisión con el motivo de la operación.`,
        );
      }
      const review = await this.orderReviewService.createReviewRequest({
        userId,
        flowType: dto.flow_type,
        amount: dto.amount,
        currency: inputCurrency,
        amountUsdEquiv: limitCheck.amountUsd,
        limitUsd: limitCheck.max,
        excessUsd: parseFloat(
          (limitCheck.amountUsd - limitCheck.max).toFixed(2),
        ),
        requestPayload: dto as unknown as Record<string, unknown>,
        clientReason: reviewContext.clientReason,
        documentUrl: reviewContext.documentUrl,
      });
      return { _type: 'review_request' as const, review };
    }

    let walletRampOrder: any;
    switch (dto.flow_type) {
      case WalletRampFlowType.FIAT_BO_TO_BRIDGE_WALLET:
        walletRampOrder = await this.createFiatBoToBridgeWallet(userId, dto);
        break;
      case WalletRampFlowType.CRYPTO_TO_BRIDGE_WALLET:
        walletRampOrder = await this.createCryptoToBridgeWallet(userId, dto);
        break;
      case WalletRampFlowType.BRIDGE_WALLET_TO_FIAT_BO:
        walletRampOrder = await this.createBridgeWalletToFiatBo(userId, dto);
        break;
      case WalletRampFlowType.BRIDGE_WALLET_TO_CRYPTO:
        walletRampOrder = await this.createBridgeWalletToCrypto(userId, dto);
        break;
      case WalletRampFlowType.BRIDGE_WALLET_TO_FIAT_US:
        walletRampOrder = await this.createBridgeWalletToFiatUs(userId, dto);
        break;
      case WalletRampFlowType.WALLET_TO_FIAT:
        walletRampOrder = await this.createWalletToFiat(userId, dto);
        break;
      default:
        throw new BadRequestException(`Flujo no soportado: ${dto.flow_type}`);
    }

    // Audit trail de creación de orden wallet ramp (best-effort)
    void this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'client',
      action: 'CREATE_WALLET_RAMP_ORDER',
      table_name: 'payment_orders',
      record_id: walletRampOrder.id,
      new_values: {
        flow_type: walletRampOrder.flow_type,
        amount: walletRampOrder.amount,
        currency: walletRampOrder.currency,
        status: walletRampOrder.status,
      },
      source: 'api',
    });

    // Notificar al staff que hay una nueva orden
    this.ordersGateway.emitOrderCreated({
      id: walletRampOrder.id,
      user_id: walletRampOrder.user_id,
      flow_type: walletRampOrder.flow_type,
      flow_category: walletRampOrder.flow_category ?? 'wallet_ramp',
      amount: parseFloat(walletRampOrder.amount),
      currency: walletRampOrder.currency,
      status: walletRampOrder.status,
      created_at: walletRampOrder.created_at,
    });

    return walletRampOrder;
  }

  /**
   * 2.1 Fiat BO → Wallet Bridge (PSAV on-ramp)
   * BOB → PSAV → fondea wallet Bridge del usuario
   */
  private async createFiatBoToBridgeWallet(
    userId: string,
    dto: CreateWalletRampOrderDto,
  ) {
    const wallet = await this.getUserWallet(userId, dto.wallet_id);

    const resolvedFiatBoDest = (
      dto.destination_currency ?? 'usdc'
    ).toLowerCase();
    if (!isValidFiatBoDestination(resolvedFiatBoDest)) {
      throw new BadRequestException(
        `El token ${resolvedFiatBoDest.toUpperCase()} no está soportado para fondeo con BOB. Tokens permitidos: USDC, USDT, USDB, PYUSD, EURC.`,
      );
    }

    // ── Validar bridge_customer_id (requerido por Bridge API) ──
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.bridge_customer_id) {
      throw new BadRequestException(
        'El usuario no tiene un bridge_customer_id configurado. Por favor, completa el registro.',
      );
    }

    const psavAccount = await this.psavService.getDepositAccount(
      'bank_bo',
      'BOB',
    );
    const depositInstructions =
      this.psavService.formatDepositInstructions(psavAccount);

    const { fee_amount, net_amount } = await this.feesService.calculateFee(
      userId,
      'ramp_on_bo',
      'psav',
      dto.amount,
    );

    const rateData = await this.exchangeRatesService.getRate('BOB_USD');
    // Tipo de cambio congelado por el cliente en la revisión (Step 4). Si llegó,
    // prevalece sobre el rate actual del servidor para honrar lo que el cliente aceptó.
    const appliedRate =
      dto.exchange_rate_applied && dto.exchange_rate_applied > 0
        ? dto.exchange_rate_applied
        : rateData.effective_rate;

    // ── Resolver fuente del PSAV según token destino ──
    const psavSource = resolvePsavCryptoSource(resolvedFiatBoDest);

    // ── Bloqueo preventivo: evitar colisión de liquidation address ──
    await this.assertNoConflictingBridgeDepositOrder(
      userId,
      psavSource.currency,
      psavSource.payment_rail,
    );

    // ── Convertir montos BOB → USDC (estimado interno, no se envía a Bridge) ──
    // Con flexible_amount Bridge acepta cualquier monto; usamos el estimado solo para
    // el registro interno (bridge_transfers, ledger_entry pendiente, amount_destination).
    const bridgeAmountEstimated = (dto.amount / appliedRate).toFixed(2);
    const netAmountUsdc = parseFloat((net_amount / appliedRate).toFixed(2));

    // ── developer_fee_percent: fee BOB / amount BOB * 100 (el tipo de cambio se cancela) ──
    const developerFeePercent =
      dto.amount > 0 ? ((fee_amount / dto.amount) * 100).toFixed(4) : '0.0000';

    // ── Pre-generar orderId como idempotency key ──
    const orderId = crypto.randomUUID();
    const idempotencyKey = `po_fiat_bo_${orderId}`;

    // ── Llamada a Bridge Transfer API ──
    let bridgeTransfer: Record<string, unknown>;
    try {
      bridgeTransfer = await this.bridgeApi.post<Record<string, unknown>>(
        '/v0/transfers',
        {
          on_behalf_of: profile.bridge_customer_id,
          source: psavSource,
          destination: {
            payment_rail: wallet.network,
            currency: resolvedFiatBoDest,
            bridge_wallet_id: wallet.provider_wallet_id,
          },
          developer_fee_percent: developerFeePercent,
          client_reference_id: orderId,
          features: {
            flexible_amount: true,
            allow_any_from_address: true,
          },
        },
        idempotencyKey,
      );
    } catch (err: any) {
      this.logger.error('Error llamando a Bridge Transfer API (fiat_bo):', err);
      const bridgeError =
        err?.response?.data?.message || err?.message || 'Error desconocido';
      throw new BadRequestException(
        'No se pudieron generar las instrucciones de depósito en Bridge. Razón: ' +
          bridgeError,
      );
    }

    // ── Extraer dirección de liquidación para el PSAV ──
    const bridgeInstr = bridgeTransfer.source_deposit_instructions as
      | Record<string, string>
      | undefined;
    const bridgeDepositInstructions = {
      type: 'liquidation_address',
      to_address: bridgeInstr?.to_address ?? '',
      payment_rail: psavSource.payment_rail,
      currency: psavSource.currency,
      label: `PSAV deposita ${psavSource.currency.toUpperCase()} en ${psavSource.payment_rail}`,
    };

    // ── Registrar en bridge_transfers ──
    const { data: bridgeTransferRow } = await this.supabase
      .from('bridge_transfers')
      .insert({
        user_id: userId,
        bridge_transfer_id: bridgeTransfer.id as string,
        amount: parseFloat(bridgeAmountEstimated),
        net_amount: netAmountUsdc,
        bridge_state: (bridgeTransfer.state as string) ?? 'awaiting_funds',
        status: 'pending',
        source_payment_rail: psavSource.payment_rail,
        destination_payment_rail: wallet.network,
        destination_currency: resolvedFiatBoDest.toUpperCase(),
        bridge_raw_response: bridgeTransfer,
      })
      .select('id')
      .single();

    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        id: orderId,
        user_id: userId,
        wallet_id: wallet.id,
        flow_type: 'fiat_bo_to_bridge_wallet',
        flow_category: 'wallet_ramp',
        requires_psav: true,
        amount: dto.amount,
        currency: 'BOB',
        fee_amount,
        net_amount,
        source_type: 'psav_bo',
        source_network: psavSource.payment_rail,
        source_currency: psavSource.currency.toUpperCase(),
        destination_type: 'bridge_wallet',
        destination_currency: resolvedFiatBoDest.toUpperCase(),
        bridge_transfer_id: bridgeTransfer.id as string,
        bridge_source_deposit_instructions: bridgeDepositInstructions,
        exchange_rate_applied: appliedRate,
        amount_destination: netAmountUsdc,
        psav_deposit_instructions: depositInstructions,
        notes: dto.notes,
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        deposit_reference_code: this.generateDepositReferenceCode(),
        status: 'waiting_deposit',
      })
      .select()
      .single();

    if (error) throwDbError(error);

    // ── Ledger entry pendiente — se liquida con webhook ──
    await this.supabase.from('ledger_entries').insert({
      wallet_id: wallet.id,
      type: 'credit',
      amount: netAmountUsdc,
      currency: resolvedFiatBoDest.toUpperCase(),
      status: 'pending',
      reference_type: 'payment_order',
      reference_id: orderId,
      bridge_transfer_id: (bridgeTransfer.id as string) ?? null,
      description: `On-ramp BOB: ${dto.amount} BOB → ${netAmountUsdc} ${resolvedFiatBoDest.toUpperCase()} vía PSAV (${psavSource.payment_rail})`,
    });

    this.logger.log(
      `📋 Orden fiat_bo_to_bridge_wallet: ${orderId} — ${dto.amount} BOB → ${netAmountUsdc} ${resolvedFiatBoDest.toUpperCase()} | Bridge transfer: ${bridgeTransfer.id}`,
    );
    return order;
  }

  /**
   * 2.2 Crypto → Wallet Bridge (Depósito directo vía bridge_wallet_id)
   * Crypto externo → Bridge (allow_any_from_address) → wallet Bridge
   */
  private async createCryptoToBridgeWallet(
    userId: string,
    dto: CreateWalletRampOrderDto,
  ) {
    const wallet = await this.getUserWallet(userId, dto.wallet_id);

    const [{ fee_amount, net_amount }, feePercent] = await Promise.all([
      this.feesService.calculateFee(
        userId,
        'ramp_on_crypto',
        'bridge',
        dto.amount ?? 0,
      ),
      this.feesService.getFeePercent(userId, 'ramp_on_crypto', 'bridge'),
    ]);

    const { data: profile } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.bridge_customer_id) {
      throw new BadRequestException(
        'El usuario no tiene un bridge_customer_id configurado. Por favor, completa el registro.',
      );
    }
    // ── Resolver moneda destino explícita ──
    const resolvedDestCurrency = (
      dto.destination_currency ?? 'usdc'
    ).toLowerCase();
    const resolvedSourceCurrency = (
      dto.source_currency ?? 'usdc'
    ).toLowerCase();
    const resolvedSourceNetwork = dto.source_network ?? wallet.network;

    if (!resolvedSourceNetwork) {
      throw new BadRequestException(
        'Debe especificar la red de origen (source_network).',
      );
    }

    // ── Validar que la moneda de ORIGEN esté habilitada en currency_settings ──
    // createWalletRampOrder solo verifica destination_currency; para este flujo
    // también bloqueamos el token fuente si está deshabilitado en la plataforma.
    await this.assertCurrencyActive(resolvedSourceCurrency);

    // ── Validar compatibilidad de ruta contra catálogo Bridge ──
    if (
      !isValidOnRampSourceForDest(
        resolvedDestCurrency,
        resolvedSourceNetwork,
        resolvedSourceCurrency,
      )
    ) {
      throw new BadRequestException(
        `La combinación ${resolvedSourceNetwork}/${resolvedSourceCurrency} → ${resolvedDestCurrency} no es soportada por Bridge.`,
      );
    }

    // ── Validar monto mínimo según catálogo Bridge (solo si se envía monto) ──
    const minAmount = getMinAmountByDest(
      resolvedDestCurrency,
      resolvedSourceNetwork,
      resolvedSourceCurrency,
    );
    if ((dto.amount ?? 0) > 0 && dto.amount < minAmount) {
      throw new BadRequestException(
        `El monto mínimo para ${resolvedSourceCurrency.toUpperCase()} en ${resolvedSourceNetwork} es ${minAmount}.`,
      );
    }

    // ── Bloqueo preventivo: evitar colisión de liquidation address ──
    await this.assertNoConflictingBridgeDepositOrder(
      userId,
      resolvedSourceCurrency,
      resolvedSourceNetwork,
    );

    // 1. Llamada a Bridge Transfer API
    // Pre-generar UUID para la orden — se reutiliza como idempotency key
    // para que retries contra Bridge no dupliquen el transfer.
    const orderId = crypto.randomUUID();
    let bridgeTransfer: Record<string, unknown>;
    const idempotencyKey = `po_c2bw_${orderId}`;
    try {
      bridgeTransfer = await this.bridgeApi.post<Record<string, unknown>>(
        '/v0/transfers',
        {
          on_behalf_of: profile.bridge_customer_id,
          source: {
            payment_rail: resolvedSourceNetwork,
            currency: resolvedSourceCurrency,
          },
          destination: {
            payment_rail: wallet.network,
            currency: resolvedDestCurrency,
            bridge_wallet_id: wallet.provider_wallet_id,
          },
          developer_fee_percent: feePercent,
          client_reference_id: orderId,
          features: {
            allow_any_from_address: true,
            flexible_amount: true,
          },
        },
        idempotencyKey,
      );
    } catch (err: any) {
      this.logger.error('Error llamando a Bridge Transfer API:', err);
      const bridgeError =
        err?.response?.data?.message || err?.message || 'Error desconocido';
      throw new BadRequestException(
        'No se pudieron generar las instrucciones de depósito en Bridge. Razón: ' +
          bridgeError,
      );
    }

    // 2. Extraer instrucciones de depósito
    const bridgeInstr = bridgeTransfer.source_deposit_instructions as
      | Record<string, string>
      | undefined;
    const depositInstructions = {
      type: 'liquidation_address',
      address: bridgeInstr?.to_address ?? bridgeInstr?.address ?? '',
      chain:
        bridgeInstr?.payment_rail ?? bridgeInstr?.chain ?? dto.source_network,
      label: `Transferencia Bridge (${dto.source_network})`,
    };

    // 3. Crear registro de puente
    const { data: bridgeTransferRow } = await this.supabase
      .from('bridge_transfers')
      .insert({
        user_id: userId,
        bridge_transfer_id: bridgeTransfer.id as string,
        amount: dto.amount ?? 0,
        net_amount: net_amount,
        bridge_state: (bridgeTransfer.state as string) ?? 'payment_submitted',
        status: 'pending',
        source_payment_rail: resolvedSourceNetwork,
        source_currency: resolvedSourceCurrency.toUpperCase(),
        destination_payment_rail: wallet.network,
        destination_currency: resolvedDestCurrency.toUpperCase(),
        bridge_raw_response: bridgeTransfer,
      })
      .select('id')
      .single();

    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        id: orderId,
        user_id: userId,
        wallet_id: wallet.id,
        flow_type: 'crypto_to_bridge_wallet',
        flow_category: 'wallet_ramp',
        requires_psav: false,
        amount: dto.amount ?? 0,
        currency: (dto.source_currency ?? 'usdc').toUpperCase(),
        fee_amount,
        net_amount,
        source_type: 'crypto_external',
        source_currency: resolvedSourceCurrency.toUpperCase(),
        source_address: dto.source_address ?? null,
        source_network: resolvedSourceNetwork,
        destination_type: 'bridge_wallet',
        destination_currency: resolvedDestCurrency.toUpperCase(),
        exchange_rate_applied: 1.0,
        bridge_transfer_id: bridgeTransfer.id as string,
        bridge_source_deposit_instructions: depositInstructions,
        notes:
          dto.notes ??
          `On-ramp crypto flexible: ${resolvedSourceCurrency.toUpperCase()} (${resolvedSourceNetwork}) → Bridge Wallet`,
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        status: 'waiting_deposit',
      })
      .select()
      .single();

    if (error) throwDbError(error);

    // 4. Crear ledger entry (credit, pending — se liquida con webhook)
    // NOTA: amount arranca en 0 porque flexible_amount=true; se actualiza con
    // receipt.final_amount cuando Bridge confirma la transferencia (handleTransferComplete).
    await this.supabase.from('ledger_entries').insert({
      wallet_id: wallet.id,
      type: 'credit',
      amount: net_amount,
      currency: resolvedDestCurrency.toUpperCase(),
      status: 'pending',
      reference_type: 'payment_order',
      reference_id: order.id,
      bridge_transfer_id: (bridgeTransfer.id as string) ?? null,
      description: `On-ramp crypto (flexible): ${resolvedSourceCurrency.toUpperCase()} (${resolvedSourceNetwork}) → ${resolvedDestCurrency.toUpperCase()} · Bridge Wallet · monto real confirmado por webhook`,
    });

    this.logger.log(
      `📋 Orden crypto_to_bridge_wallet: ${order.id} — flexible_amount (fee_percent: ${feePercent}%)`,
    );
    return order;
  }

  /**
   * 2.4 Wallet Bridge → Fiat BO (Bridge Transfer + PSAV off-ramp)
   *
   * Flujo de dos tramos:
   *   Tramo 1 (automático): Wallet Bridge del usuario → POST /v0/transfers → Wallet Crypto del PSAV
   *   Tramo 2 (manual):     PSAV convierte USDC → BOB → deposita en cuenta BO del usuario
   *
   * El webhook transfer.complete asienta el ledger y libera la reserva (Tramo 1).
   * Staff completa la orden cuando el PSAV confirma el depósito BOB (Tramo 2).
   */
  private async createBridgeWalletToFiatBo(
    userId: string,
    dto: CreateWalletRampOrderDto,
  ) {
    // 1. Obtener cuenta bancaria aprobada del perfil del cliente
    const bankAccount =
      await this.bankAccountsService.getApprovedAccountForWithdrawal(userId);

    const wallet = await this.getUserWallet(userId, dto.wallet_id);

    const { fee_amount, net_amount } = await this.feesService.calculateFee(
      userId,
      'ramp_off_bo',
      'psav',
      dto.amount,
    );

    const sourceCurrency = (dto.source_currency ?? 'usdc').toUpperCase();

    // Validar token y ruta PSAV antes de tocar el saldo — sin coste de rollback si falla
    if (
      !FIAT_BO_OFF_RAMP_SOURCE_CURRENCIES.includes(sourceCurrency.toLowerCase())
    ) {
      throw new BadRequestException(
        `El token ${sourceCurrency} no está habilitado para retiro a Bolivia. Tokens permitidos: ${FIAT_BO_OFF_RAMP_SOURCE_CURRENCIES.map((t) => t.toUpperCase()).join(', ')}.`,
      );
    }

    const activePsavAccounts = await this.psavService.getActiveCryptoAccounts();
    const psavMatch = resolveFiatBoPsavMatch(
      sourceCurrency,
      activePsavAccounts,
    );

    if (!psavMatch) {
      throw new BadRequestException(
        `No es posible retirar ${sourceCurrency} a Bolivia en este momento. ` +
          `El operador PSAV no tiene habilitada una cuenta ${sourceCurrency} activa. ` +
          `Por favor retira usando uno de los tokens disponibles o contacta al soporte.`,
      );
    }

    const {
      psavAccount,
      destCurrency: psavDestCurrency,
      minAmount: routeMinAmount,
    } = psavMatch;

    if (!psavAccount.crypto_address) {
      throw new BadRequestException(
        `La cuenta PSAV para ${sourceCurrency} no tiene dirección crypto configurada. Contacta al administrador.`,
      );
    }

    if (dto.amount < routeMinAmount) {
      throw new BadRequestException(
        `El monto mínimo para retirar ${sourceCurrency.toUpperCase()} a Bolivia es ${routeMinAmount} ${sourceCurrency.toUpperCase()}.`,
      );
    }

    // Verificar saldo disponible del token específico seleccionado
    const { data: balance } = await this.supabase
      .from('balances')
      .select('available_amount')
      .eq('user_id', userId)
      .eq('currency', sourceCurrency)
      .single();

    const totalNeeded = dto.amount;
    if (!balance || parseFloat(balance.available_amount ?? '0') < totalNeeded) {
      throw new BadRequestException(
        `Saldo insuficiente. Necesitas $${totalNeeded} pero tienes $${balance?.available_amount ?? 0}`,
      );
    }

    // Bloquear si ya existe un off-ramp activo desde la misma moneda
    await this.assertNoConflictingOffRampOrder(
      userId,
      'bridge_wallet_to_fiat_bo',
      sourceCurrency,
    );

    // Validar bridge_customer_id antes de reservar saldo
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.bridge_customer_id) {
      throw new BadRequestException(
        'El usuario no tiene una cuenta Bridge activa. Completa el KYC antes de realizar retiros.',
      );
    }

    const rateData = await this.exchangeRatesService.getRate('USD_BOB');
    // Validar que el rate congelado no difiera >3% del live antes de reservar saldo.
    if (dto.exchange_rate_applied && dto.exchange_rate_applied > 0) {
      const liveBase = rateData.effective_rate;
      const deviation = Math.abs(dto.exchange_rate_applied - liveBase) / liveBase;
      const MAX_RATE_DEVIATION = 0.03;
      if (deviation > MAX_RATE_DEVIATION) {
        throw new BadRequestException(
          `La cotización ha variado un ${(deviation * 100).toFixed(1)}% desde que fue generada. ` +
          `Por favor vuelve a cotizar para continuar.`,
        );
      }
    }

    // Reservar saldo
    await this.supabase.rpc('reserve_balance', {
      p_user_id: userId,
      p_currency: sourceCurrency,
      p_amount: totalNeeded,
    });

    // Tipo de cambio congelado por el cliente en la revisión (Step 4). Si llegó,
    // prevalece sobre el rate actual del servidor para honrar lo que el cliente aceptó.
    const appliedRate =
      dto.exchange_rate_applied && dto.exchange_rate_applied > 0
        ? dto.exchange_rate_applied
        : rateData.effective_rate;

    // Snapshot: los datos bancarios se copian en la orden para trazabilidad histórica
    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        wallet_id: wallet.id,
        flow_type: 'bridge_wallet_to_fiat_bo',
        flow_category: 'wallet_ramp',
        requires_psav: true,
        amount: dto.amount,
        currency: sourceCurrency,
        source_currency: sourceCurrency,
        fee_amount,
        net_amount,
        destination_type: 'bank_bo',
        destination_currency: 'BOB',
        destination_bank_name: bankAccount.bank_name,
        destination_account_number: bankAccount.account_number,
        destination_account_holder: bankAccount.account_holder,
        client_bank_account_id: bankAccount.id,
        destination_qr_url: dto.destination_qr_url,
        exchange_rate_applied: appliedRate,
        amount_destination: parseFloat((net_amount * appliedRate).toFixed(2)),
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        notes: dto.notes,
        status: 'created',
      })
      .select()
      .single();

    if (error) {
      await this.supabase.rpc('release_reserved_balance', {
        p_user_id: userId,
        p_currency: sourceCurrency,
        p_amount: totalNeeded,
      });
      throwDbError(error);
    }

    // Ejecutar Tramo 1: Bridge Transfer → PSAV crypto wallet
    try {
      // Validar y normalizar la red del PSAV
      if (
        !psavAccount.crypto_network ||
        psavAccount.crypto_network.trim() === ''
      ) {
        throw new Error(
          `La cuenta PSAV para ${sourceCurrency} no tiene red crypto configurada. Contacta al administrador.`,
        );
      }
      const psavRail = psavAccount.crypto_network.toLowerCase().trim();
      if (!ALLOWED_NETWORKS.includes(psavRail)) {
        throw new Error(
          `Red PSAV inválida: "${psavAccount.crypto_network}" (normalizada: "${psavRail}"). Valores permitidos: ${ALLOWED_NETWORKS.join(', ')}`,
        );
      }

      const transferPayload = {
        on_behalf_of: profile.bridge_customer_id,
        source: {
          payment_rail: 'bridge_wallet',
          currency: sourceCurrency.toLowerCase(),
          bridge_wallet_id: wallet.provider_wallet_id,
        },
        destination: {
          payment_rail: psavRail,
          currency: psavDestCurrency.toLowerCase(),
          to_address: psavAccount.crypto_address,
        },
        amount: dto.amount.toFixed(2),
        ...(fee_amount > 0 && { developer_fee: fee_amount.toFixed(2) }),
        client_reference_id: order.id,
      };

      this.logger.log(
        `🔍 Bridge Transfer payload (fiat_bo): ${JSON.stringify(transferPayload)}`,
      );

      const idempotencyKey = `po_w2fbo_${order.id}`;
      const bridgeResult = await this.bridgeApi.post<Record<string, unknown>>(
        '/v0/transfers',
        transferPayload,
        idempotencyKey,
      );

      const transferId = (bridgeResult?.id ?? null) as string | null;
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'processing',
          bridge_transfer_id: transferId,
        })
        .eq('id', order.id);

      // Crear registro bridge_transfers para que el webhook pueda vincularlo
      const { data: btRow } = await this.supabase
        .from('bridge_transfers')
        .insert({
          user_id: userId,
          bridge_transfer_id: transferId,
          source_payment_rail: 'bridge_wallet',
          source_currency: sourceCurrency.toLowerCase(),
          destination_payment_rail: psavRail,
          destination_currency: psavDestCurrency.toLowerCase(),
          amount: dto.amount,
          developer_fee_amount: fee_amount,
          net_amount,
          status: 'pending',
          bridge_state: (bridgeResult?.state as string) ?? 'awaiting_funds',
          bridge_raw_response: bridgeResult,
        })
        .select('id')
        .single();

      // Crear ledger entry (debit, pending — se asienta con webhook transfer.complete).
      // bridge_transfer_id referencia el id LOCAL de bridge_transfers (FK) — NO el UUID de Bridge.
      const { error: ledgerErr } = await this.supabase
        .from('ledger_entries')
        .insert({
          wallet_id: wallet.id,
          type: 'debit',
          amount: totalNeeded,
          currency: sourceCurrency,
          status: 'pending',
          reference_type: 'payment_order',
          reference_id: order.id,
          bridge_transfer_id: btRow?.id ?? null,
          description: `Off-ramp BO: ${net_amount} ${sourceCurrency} → BOB (PSAV)`,
        });
      if (ledgerErr) {
        this.logger.error(
          `❌ No se pudo crear el ledger_entry (debit) de la order ${order.id}: ${ledgerErr.message}. ` +
            `El transfer Bridge ${transferId} ya fue enviado — requiere reconciliación manual del saldo.`,
        );
      }

      order.status = 'processing';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Revertir: liberar reserva + marcar failed
      await this.supabase.rpc('release_reserved_balance', {
        p_user_id: userId,
        p_currency: sourceCurrency,
        p_amount: totalNeeded,
      });
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'failed',
          failure_reason: `Bridge Transfer falló: ${message}`,
        })
        .eq('id', order.id);

      void this.notifyOrderFinalStatusEmail(order, 'failed');

      throw new BadRequestException(
        `Error al ejecutar transfer BO: ${message}`,
      );
    }

    this.logger.log(
      `📋 Orden bridge_wallet_to_fiat_bo: ${order.id} — ${dto.amount} ${sourceCurrency}→BOB (Bridge Transfer → PSAV)`,
    );
    return order;
  }

  /**
   * 2.5 Wallet Bridge → Crypto (Bridge Transfer)
   * Wallet Bridge → Bridge Transfer API → wallet crypto externo
   */
  private async createBridgeWalletToCrypto(
    userId: string,
    dto: CreateWalletRampOrderDto,
  ) {
    const wallet = await this.getUserWallet(userId, dto.wallet_id);

    const { fee_amount, net_amount } = await this.feesService.calculateFee(
      userId,
      'ramp_off_crypto',
      'bridge',
      dto.amount,
    );

    // Verificar saldo del token específico
    const sourceCurrency = (dto.source_currency ?? 'usdc').toUpperCase();
    const { data: balance } = await this.supabase
      .from('balances')
      .select('available_amount')
      .eq('user_id', userId)
      .eq('currency', sourceCurrency)
      .single();

    const totalNeeded = dto.amount;
    if (!balance || parseFloat(balance.available_amount ?? '0') < totalNeeded) {
      throw new BadRequestException(
        `Saldo insuficiente. Necesitas $${totalNeeded} pero tienes $${balance?.available_amount ?? 0}`,
      );
    }

    // Fix #5: Validar red y ruta off-ramp antes de reservar saldo ni tocar estado.
    // Evita que redes en ALLOWED_NETWORKS pero sin rutas (ej: 'base') lleguen al try block,
    // preveniendo órdenes 'failed' por validación y el ciclo innecesario reserve→release.
    const destinationRailPre = (dto.destination_network ?? '')
      .toLowerCase()
      .trim();
    if (!ALLOWED_NETWORKS.includes(destinationRailPre as any)) {
      throw new BadRequestException(
        `Red de destino inválida: "${dto.destination_network}". Redes permitidas: ${ALLOWED_NETWORKS.join(', ')}`,
      );
    }
    const destCurrencyPre = (
      dto.destination_currency ?? sourceCurrency
    ).toLowerCase();
    if (
      !isValidOffRampRoute(
        sourceCurrency.toLowerCase(),
        destinationRailPre,
        destCurrencyPre,
      )
    ) {
      throw new BadRequestException(
        `Ruta off-ramp no soportada: ${sourceCurrency} → ${destinationRailPre} → ${destCurrencyPre.toUpperCase()}. Verifica las combinaciones válidas en el catálogo Bridge.`,
      );
    }

    // Bloquear si ya existe un off-ramp crypto activo hacia la misma red
    await this.assertNoConflictingCryptoOffRamp(
      userId,
      sourceCurrency,
      dto.destination_network ?? '',
    );

    // Validar monto mínimo antes de reservar saldo
    const routeMin = getOffRampMinAmount(
      sourceCurrency.toLowerCase(),
      destinationRailPre,
      destCurrencyPre,
    );
    if (routeMin > 0 && dto.amount < routeMin) {
      throw new BadRequestException(
        `Monto mínimo para esta ruta es ${routeMin} ${sourceCurrency}. Ingresaste ${dto.amount}.`,
      );
    }

    // Validar bridge_customer_id antes de reservar saldo
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.bridge_customer_id) {
      throw new BadRequestException(
        'El usuario no tiene una cuenta Bridge activa. Completa el KYC antes de realizar retiros.',
      );
    }

    // Reservar saldo
    await this.supabase.rpc('reserve_balance', {
      p_user_id: userId,
      p_currency: sourceCurrency,
      p_amount: totalNeeded,
    });

    // Crear orden
    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        wallet_id: wallet.id,
        flow_type: 'bridge_wallet_to_crypto',
        flow_category: 'wallet_ramp',
        requires_psav: false,
        amount: dto.amount,
        currency: sourceCurrency,
        source_currency: sourceCurrency, // Fix #1: requerido por idx_po_bw2c_active_per_src_dest y assertNoConflictingCryptoOffRamp
        fee_amount,
        net_amount,
        destination_type: 'crypto_address',
        destination_address: dto.destination_address,
        destination_network: dto.destination_network,
        destination_currency: (
          dto.destination_currency ?? sourceCurrency
        ).toUpperCase(), // Fix #4: siempre uppercase
        exchange_rate_applied: 1.0,
        // 1:1 stablecoin → el crédito neto estimado se conoce desde la creación.
        // El webhook transfer.complete lo confirma con receipt.final_amount.
        amount_destination: net_amount,
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        notes: dto.notes,
        status: 'created',
      })
      .select()
      .single();

    if (error) {
      await this.supabase.rpc('release_reserved_balance', {
        p_user_id: userId,
        p_currency: sourceCurrency,
        p_amount: totalNeeded,
      });
      throwDbError(error);
    }

    // Ejecutar transfer vía Bridge API
    try {
      const transferPayload = {
        on_behalf_of: profile.bridge_customer_id,
        source: {
          payment_rail: 'bridge_wallet',
          currency: sourceCurrency.toLowerCase(),
          bridge_wallet_id: wallet.provider_wallet_id,
        },
        destination: {
          payment_rail: destinationRailPre,
          currency: destCurrencyPre,
          to_address: dto.destination_address,
        },
        amount: dto.amount.toFixed(2),
        ...(fee_amount > 0 && { developer_fee: fee_amount.toFixed(2) }),
        client_reference_id: order.id,
      };

      this.logger.log(
        `🔍 [bridge_wallet_to_crypto] Bridge payload: ${JSON.stringify(transferPayload)}`,
      );

      const idempotencyKey = `po_w2c_${order.id}`;
      const bridgeResult = await this.bridgeApi.post<Record<string, unknown>>(
        '/v0/transfers',
        transferPayload,
        idempotencyKey,
      );

      this.logger.log(
        `✅ [bridge_wallet_to_crypto] Bridge response: ${JSON.stringify(bridgeResult)}`,
      );

      const transferId = (bridgeResult?.id ?? null) as string | null;
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'processing',
          bridge_transfer_id: transferId,
        })
        .eq('id', order.id);

      // Crear registro bridge_transfers para que el webhook pueda vincularlo
      // (consistente con bridge_wallet_to_fiat_bo y bridge_wallet_to_fiat_us)
      const { data: btRow } = await this.supabase
        .from('bridge_transfers')
        .insert({
          user_id: userId,
          bridge_transfer_id: transferId,
          source_payment_rail: 'bridge_wallet',
          source_currency: sourceCurrency.toLowerCase(),
          destination_payment_rail: destinationRailPre,
          destination_currency: (
            dto.destination_currency ?? sourceCurrency
          ).toLowerCase(),
          amount: dto.amount,
          developer_fee_amount: fee_amount,
          net_amount,
          status: 'pending',
          bridge_state: (bridgeResult?.state as string) ?? 'awaiting_funds',
          bridge_raw_response: bridgeResult,
        })
        .select('id')
        .single();

      // Crear ledger entry (pending, se liquida con webhook).
      // bridge_transfer_id referencia el id LOCAL de bridge_transfers (FK) y es el
      // valor por el que el webhook asienta el débito — NO el UUID de Bridge (transferId).
      const { error: ledgerErr } = await this.supabase
        .from('ledger_entries')
        .insert({
          wallet_id: wallet.id,
          type: 'debit',
          amount: totalNeeded,
          currency: sourceCurrency,
          status: 'pending',
          reference_type: 'payment_order',
          reference_id: order.id,
          bridge_transfer_id: btRow?.id ?? null,
          description: `Off-ramp crypto: ${net_amount} ${sourceCurrency} → ${dto.destination_address}`,
        });
      if (ledgerErr) {
        this.logger.error(
          `❌ No se pudo crear el ledger_entry (debit) de la order ${order.id}: ${ledgerErr.message}. ` +
            `El transfer Bridge ${transferId} ya fue enviado — requiere reconciliación manual del saldo.`,
        );
      }

      order.status = 'processing';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        '\n══════════ [bridge_wallet_to_crypto] ERROR ← Bridge API ════════════',
        '\nmessage:',
        message,
        '\nraw:',
        err,
        '\n════════════════════════════════════════════════════════════════════\n',
      );
      // Revertir
      await this.supabase.rpc('release_reserved_balance', {
        p_user_id: userId,
        p_currency: sourceCurrency,
        p_amount: totalNeeded,
      });
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'failed',
          failure_reason: `Bridge Transfer falló: ${message}`,
        })
        .eq('id', order.id);

      void this.notifyOrderFinalStatusEmail(order, 'failed');

      throw new BadRequestException(
        `Error al ejecutar transfer crypto: ${message}`,
      );
    }

    this.logger.log(
      `📋 Orden bridge_wallet_to_crypto: ${order.id} — ${dto.amount} → ${dto.destination_address}`,
    );
    return order;
  }

  /**
   * 2.6 Wallet Bridge → Fiat US (Bridge Transfer a external_account)
   * Wallet Bridge → Bridge Transfer → cuenta bancaria US/SEPA/PIX
   */
  private async createBridgeWalletToFiatUs(
    userId: string,
    dto: CreateWalletRampOrderDto,
  ) {
    const wallet = await this.getUserWallet(userId, dto.wallet_id);

    // 1. Validar proveedor: debe pertenecer al usuario y tener bridge_external_account_id
    if (!dto.supplier_id) {
      throw new BadRequestException(
        'Debes especificar un proveedor (supplier_id) para el flujo bridge_wallet_to_fiat_us',
      );
    }
    const { data: supplier } = await this.supabase
      .from('suppliers')
      .select('id, name, bridge_external_account_id, bank_details')
      .eq('id', dto.supplier_id)
      .eq('user_id', userId)
      .single();

    if (!supplier || !supplier.bridge_external_account_id) {
      throw new NotFoundException(
        'Proveedor no encontrado o no tiene cuenta bancaria registrada en Bridge.',
      );
    }

    // 2. Cargar external_account del proveedor (sin filtrar por user_id — pertenece al proveedor)
    const { data: extAccount } = await this.supabase
      .from('bridge_external_accounts')
      .select(
        'id, account_type, currency, bridge_external_account_id, payment_rail',
      )
      .eq('id', supplier.bridge_external_account_id)
      .eq('is_active', true)
      .single();

    if (!extAccount || !extAccount.bridge_external_account_id) {
      throw new NotFoundException(
        'La cuenta bancaria del proveedor no está activa o no está registrada en Bridge.',
      );
    }

    if (!extAccount.payment_rail) {
      throw new BadRequestException(
        'La cuenta bancaria del proveedor no tiene payment_rail configurado. ' +
          'Actualice los datos del proveedor antes de realizar el retiro.',
      );
    }

    // Validar bridge_customer_id antes de operar con saldo
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.bridge_customer_id) {
      throw new BadRequestException(
        'El usuario no tiene una cuenta Bridge activa. Completa el KYC antes de realizar retiros.',
      );
    }

    const { fee_amount, net_amount } = await this.feesService.calculateFee(
      userId,
      'ramp_off_fiat_us',
      'bridge',
      dto.amount,
    );

    // Verificar saldo del token específico
    const sourceCurrency = (dto.source_currency ?? 'usdc').toUpperCase();
    const { data: balance } = await this.supabase
      .from('balances')
      .select('available_amount')
      .eq('user_id', userId)
      .eq('currency', sourceCurrency)
      .single();

    const totalNeeded = dto.amount;
    if (!balance || parseFloat(balance.available_amount ?? '0') < totalNeeded) {
      throw new BadRequestException(
        `Saldo insuficiente. Necesitas $${totalNeeded} pero tienes $${balance?.available_amount ?? 0}`,
      );
    }

    // Bloquear si ya existe un off-ramp fiat US activo hacia el mismo proveedor
    await this.assertNoConflictingFiatUsOffRamp(
      userId,
      sourceCurrency,
      dto.supplier_id,
    );

    // Validar que el rate congelado no difiera >3% del rate live (solo para destinos no-USD).
    // Protege contra rates obsoletos si el cliente tardó horas en confirmar en el paso review.
    const destCurrency = (extAccount.currency ?? 'USD').toUpperCase();
    if (
      destCurrency !== 'USD' &&
      dto.exchange_rate_applied &&
      dto.exchange_rate_applied > 0
    ) {
      const liveRate = await this.exchangeRatesService.getRate(`USD_${destCurrency}`);
      const liveBase = liveRate.effective_rate;
      const deviation = Math.abs(dto.exchange_rate_applied - liveBase) / liveBase;
      const MAX_RATE_DEVIATION = 0.03;
      if (deviation > MAX_RATE_DEVIATION) {
        throw new BadRequestException(
          `La cotización ha variado un ${(deviation * 100).toFixed(1)}% desde que fue generada. ` +
          `Por favor vuelve a cotizar para continuar.`,
        );
      }
    }

    // Reservar saldo
    await this.supabase.rpc('reserve_balance', {
      p_user_id: userId,
      p_currency: sourceCurrency,
      p_amount: totalNeeded,
    });

    const bankDetails = supplier.bank_details as Record<string, unknown> | null;
    const rawAccountNumber = bankDetails?.account_number as string | undefined;
    const destinationAccountNumber = rawAccountNumber
      ? `****${rawAccountNumber.slice(-4)}`
      : null;

    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        wallet_id: wallet.id,
        flow_type: 'bridge_wallet_to_fiat_us',
        flow_category: 'wallet_ramp',
        requires_psav: false,
        source_type: 'bridge_wallet',
        source_currency: sourceCurrency,
        amount: dto.amount,
        currency: sourceCurrency,
        fee_amount,
        net_amount,
        destination_type: 'external_account',
        destination_currency: extAccount.currency ?? 'USD',
        // Para USD la conversión es 1:1. Para otras divisas (MXN, EUR, BRL, COP, GBP)
        // usamos la tasa congelada por el cliente en el paso de revisión.
        // El webhook transfer.complete sobreescribe con receipt.exchange_rate (tasa real de Bridge).
        exchange_rate_applied:
          (extAccount.currency ?? 'USD').toUpperCase() !== 'USD' &&
          dto.exchange_rate_applied &&
          dto.exchange_rate_applied > 0
            ? dto.exchange_rate_applied
            : 1.0,
        external_account_id: extAccount.id,
        supplier_id: supplier.id,
        destination_bank_name: (bankDetails?.bank_name as string) ?? null,
        destination_account_holder: supplier.name ?? null,
        destination_account_number: destinationAccountNumber,
        // Estimado en la divisa destino. El webhook lo sobreescribe con receipt.final_amount.
        amount_destination:
          (extAccount.currency ?? 'USD').toUpperCase() !== 'USD' &&
          dto.exchange_rate_applied &&
          dto.exchange_rate_applied > 0
            ? parseFloat((net_amount * dto.exchange_rate_applied).toFixed(2))
            : net_amount,
        notes: dto.notes,
        business_purpose: dto.business_purpose,
        supporting_document_url: dto.supporting_document_url,
        status: 'created',
      })
      .select()
      .single();

    if (error) {
      await this.supabase.rpc('release_reserved_balance', {
        p_user_id: userId,
        p_currency: sourceCurrency,
        p_amount: totalNeeded,
      });
      throwDbError(error);
    }

    // Ejecutar payout vía Bridge API usando external_account_id
    try {
      const idempotencyKey = `po_w2f_${order.id}`;
      const bridgeResult = await this.bridgeApi.post<Record<string, unknown>>(
        '/v0/transfers',
        {
          on_behalf_of: profile.bridge_customer_id,
          source: {
            payment_rail: 'bridge_wallet',
            currency: sourceCurrency.toLowerCase(),
            bridge_wallet_id: wallet.provider_wallet_id,
          },
          destination: {
            payment_rail: extAccount.payment_rail,
            currency: (extAccount.currency ?? 'usd').toLowerCase(),
            external_account_id: extAccount.bridge_external_account_id,
          },
          amount: dto.amount.toFixed(2),
          ...(fee_amount > 0 && { developer_fee: fee_amount.toFixed(2) }),
          client_reference_id: order.id,
        },
        idempotencyKey,
      );

      const transferId = (bridgeResult?.id ?? null) as string | null;
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'processing',
          bridge_transfer_id: transferId,
        })
        .eq('id', order.id);

      // Crear registro bridge_transfers para que el webhook pueda vincularlo
      // (consistente con bridge_wallet_to_fiat_bo y bridge_wallet_to_crypto)
      const { data: btRow } = await this.supabase
        .from('bridge_transfers')
        .insert({
          user_id: userId,
          bridge_transfer_id: transferId,
          source_payment_rail: 'bridge_wallet',
          source_currency: sourceCurrency.toLowerCase(),
          destination_payment_rail: extAccount.payment_rail,
          destination_currency: (extAccount.currency ?? 'usd').toLowerCase(),
          amount: dto.amount,
          developer_fee_amount: fee_amount,
          net_amount,
          status: 'pending',
          bridge_state: (bridgeResult?.state as string) ?? 'awaiting_funds',
          bridge_raw_response: bridgeResult,
        })
        .select('id')
        .single();

      // bridge_transfer_id referencia el id LOCAL de bridge_transfers (FK) — NO el UUID de Bridge.
      const { error: ledgerErr } = await this.supabase
        .from('ledger_entries')
        .insert({
          wallet_id: wallet.id,
          type: 'debit',
          amount: totalNeeded,
          currency: sourceCurrency,
          status: 'pending',
          reference_type: 'payment_order',
          reference_id: order.id,
          bridge_transfer_id: btRow?.id ?? null,
          description: `Off-ramp fiat US: $${net_amount} → cuenta bancaria`,
        });
      if (ledgerErr) {
        this.logger.error(
          `❌ No se pudo crear el ledger_entry (debit) de la order ${order.id}: ${ledgerErr.message}. ` +
            `El transfer Bridge ${transferId} ya fue enviado — requiere reconciliación manual del saldo.`,
        );
      }

      order.status = 'processing';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.supabase.rpc('release_reserved_balance', {
        p_user_id: userId,
        p_currency: sourceCurrency,
        p_amount: totalNeeded,
      });
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'failed',
          failure_reason: `Bridge Payout falló: ${message}`,
        })
        .eq('id', order.id);

      void this.notifyOrderFinalStatusEmail(order, 'failed');

      throw new BadRequestException(`Error al ejecutar payout: ${message}`);
    }

    this.logger.log(
      `📋 Orden bridge_wallet_to_fiat_us: ${order.id} — ${dto.amount} ${sourceCurrency}→USD`,
    );
    return order;
  }

  /**
   * 2.7 Wallet On-Chain → Fiat (Bridge Transfer: on-chain crypto → external_account)
   * Solana/Ethereum/Tron/Polygon/Stellar USDC → Bridge convierte → cuenta bancaria del proveedor
   * El usuario envía desde su wallet externa, no desde su wallet custodiada en Bridge.
   */
  private async createWalletToFiat(
    userId: string,
    dto: CreateWalletRampOrderDto,
  ) {
    if (!dto.supplier_id) {
      throw new BadRequestException(
        'Debes especificar un proveedor (supplier_id) para el flujo wallet_to_fiat',
      );
    }
    if (!dto.source_address) {
      throw new BadRequestException(
        'Debes especificar la dirección de origen (source_address)',
      );
    }
    if (!dto.source_network) {
      throw new BadRequestException(
        'Debes especificar la red de origen (source_network)',
      );
    }
    if (!dto.business_purpose) {
      throw new BadRequestException(
        'El motivo del retiro (business_purpose) es obligatorio para este flujo',
      );
    }

    // 1. Validar proveedor: debe pertenecer al usuario y tener bridge_external_account_id
    const { data: supplier } = await this.supabase
      .from('suppliers')
      .select('id, name, bridge_external_account_id')
      .eq('id', dto.supplier_id)
      .eq('user_id', userId)
      .single();

    if (!supplier || !supplier.bridge_external_account_id) {
      throw new NotFoundException(
        'Proveedor no encontrado o no tiene cuenta bancaria registrada en Bridge.',
      );
    }

    // 2. Cargar datos de la external_account del proveedor en Bridge
    // FIX #1: No filtrar por user_id — la cuenta bancaria pertenece al PROVEEDOR (supplier),
    // no al usuario que realiza la transferencia. El supplier ya fue validado como del usuario.
    const { data: extAccount } = await this.supabase
      .from('bridge_external_accounts')
      .select('id, bridge_external_account_id, payment_rail, currency')
      .eq('id', supplier.bridge_external_account_id)
      .eq('is_active', true)
      .single();

    if (!extAccount || !extAccount.bridge_external_account_id) {
      throw new NotFoundException(
        'La cuenta bancaria del proveedor no está activa o no está registrada en Bridge.',
      );
    }

    if (!extAccount.payment_rail) {
      throw new BadRequestException(
        'La cuenta bancaria del proveedor no tiene payment_rail configurado. ' +
          'Actualice los datos del proveedor antes de realizar el retiro.',
      );
    }

    // 3. Calcular fee
    const sourceCurrency = dto.source_currency?.toUpperCase() ?? 'USDC';
    const { fee_amount, net_amount } = await this.feesService.calculateFee(
      userId,
      'wallet_to_fiat_off', // tarifa dedicada para flujo on-chain → fiat (mayor developer fee que ramp_off_fiat_us)
      'bridge',
      dto.amount,
    );

    // 4. Obtener bridge_customer_id del usuario y wallet de referencia
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.bridge_customer_id) {
      throw new BadRequestException(
        'El usuario no tiene un customer de Bridge asociado.',
      );
    }

    // FIX #2: Resolver wallet de referencia del usuario para el asiento contable.
    // ledger_entries.wallet_id es NOT NULL — en flujos on-chain los fondos no vienen
    // de la wallet interna, pero necesitamos una referencia válida para la FK.
    const { data: refWallet } = await this.supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (!refWallet) {
      throw new BadRequestException(
        'El usuario no tiene una wallet activa en Guira.',
      );
    }

    // 5. Crear payment_order (status: pending)
    const { data: order, error } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        flow_type: 'wallet_to_fiat',
        flow_category: 'wallet_ramp',
        requires_psav: false,
        source_type: 'on_chain_wallet',
        source_address: dto.source_address,
        source_network: dto.source_network,
        source_currency: sourceCurrency,
        amount: dto.amount,
        currency: sourceCurrency,
        fee_amount,
        net_amount,
        destination_type: 'external_account',
        destination_currency: (extAccount.currency ?? 'usd').toUpperCase(),
        supplier_id: supplier.id,
        external_account_id: extAccount.id,
        business_purpose: dto.business_purpose,
        notes: dto.notes,
        status: 'pending',
      })
      .select()
      .single();

    if (error) {
      throw new BadRequestException(
        `Error al crear la orden de pago: ${error.message}`,
      );
    }

    // 6. Llamar a Bridge /v0/transfers
    try {
      const idempotencyKey = `wtf-${order.id}`;

      const bridgeResult = await this.bridgeApi.post<Record<string, unknown>>(
        '/v0/transfers',
        {
          on_behalf_of: profile.bridge_customer_id,
          source: {
            payment_rail: dto.source_network.toLowerCase(),
            currency: sourceCurrency.toLowerCase(),
            from_address: dto.source_address,
          },
          destination: {
            payment_rail: extAccount.payment_rail,
            currency: (extAccount.currency ?? 'usd').toLowerCase(),
            external_account_id: extAccount.bridge_external_account_id,
          },
          amount: dto.amount.toString(),
          developer_fee: fee_amount.toString(),
          client_reference_id: order.id,
          return_instructions: {
            address: dto.source_address,
          },
        },
        idempotencyKey,
      );

      const transferId = (bridgeResult?.id ?? null) as string | null;

      // 7. Actualizar orden a processing
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'processing',
          bridge_transfer_id: transferId,
        })
        .eq('id', order.id);

      // 8. Registrar en bridge_transfers para seguimiento de webhooks
      const { data: btRow } = await this.supabase
        .from('bridge_transfers')
        .insert({
          user_id: userId,
          bridge_transfer_id: transferId,
          source_payment_rail: dto.source_network.toLowerCase(),
          source_currency: sourceCurrency.toLowerCase(),
          destination_payment_rail: extAccount.payment_rail,
          destination_currency: (extAccount.currency ?? 'usd').toLowerCase(),
          amount: dto.amount,
          developer_fee_amount: fee_amount,
          net_amount,
          status: 'pending',
          bridge_state: (bridgeResult?.state as string) ?? 'awaiting_funds',
          bridge_raw_response: bridgeResult,
        })
        .select('id')
        .single();

      // 9. Ledger entry informativo — los fondos vienen on-chain, no del balance interno.
      // FIX #2: Usar refWallet.id como referencia FK (NOT NULL). El asiento es de tipo
      // 'debit' pendiente; se asentará a 'settled' cuando Bridge confirme el transfer.
      try {
        await this.supabase.from('ledger_entries').insert({
          wallet_id: refWallet.id, // wallet de referencia del usuario (no se debita)
          type: 'debit',
          amount: dto.amount,
          currency: sourceCurrency,
          status: 'pending',
          reference_type: 'payment_order',
          reference_id: order.id,
          bridge_transfer_id: transferId ?? null,
          description: `Wallet-to-fiat (on-chain): ${dto.amount} ${sourceCurrency} (${dto.source_network}) → ${supplier.name}`,
        });
      } catch (ledgerErr) {
        // El ledger es informativo para este flujo (los fondos no son custodiados).
        // Un fallo aquí NO debe revertir la orden — Bridge ya aceptó el transfer.
        this.logger.warn(
          `⚠️ wallet_to_fiat ${order.id}: Error al crear ledger_entry (no bloqueante): ${ledgerErr instanceof Error ? ledgerErr.message : ledgerErr}`,
        );
      }

      order.status = 'processing';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'failed',
          failure_reason: `Bridge Transfer falló: ${message}`,
        })
        .eq('id', order.id);

      void this.notifyOrderFinalStatusEmail(order, 'failed');

      throw new BadRequestException(
        `Error al ejecutar wallet-to-fiat: ${message}`,
      );
    }

    this.logger.log(
      `📋 Orden wallet_to_fiat: ${order.id} — ${dto.amount} ${sourceCurrency} (${dto.source_network}) → ${supplier.name}`,
    );
    return order;
  }

  // ═══════════════════════════════════════════════
  //  USER QUERIES & ACTIONS
  // ═══════════════════════════════════════════════

  /** Lista órdenes del usuario autenticado. */
  async getMyOrders(
    userId: string,
    filters?: {
      status?: string;
      flow_category?: string;
      page?: number;
      limit?: number;
      year?: number;
      month?: number;
    },
  ) {
    const page = filters?.page ?? 1;
    const limit = Math.min(filters?.limit ?? 20, 50);
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from('payment_orders')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters?.status) query = query.eq('status', filters.status);
    if (filters?.flow_category)
      query = query.eq('flow_category', filters.flow_category);
    if (filters?.year && Number.isFinite(filters.year)) {
      const { dateFrom, dateTo } = buildDateRange(filters.year, filters.month);
      query = query.gte('created_at', dateFrom).lt('created_at', dateTo);
    }

    const { data, count, error } = await query;
    if (error) throwDbError(error);

    return { data: data ?? [], total: count ?? 0, page, limit };
  }

  /**
   * Devuelve TODAS las órdenes del usuario que coinciden con los filtros
   * (sin paginación). Uso exclusivo para exportación de reportes.
   */
  async getOrdersForExport(
    userId: string,
    filters?: { status?: string; year?: number; month?: number },
  ) {
    let query = this.supabase
      .from('payment_orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (filters?.status) query = query.eq('status', filters.status);
    if (filters?.year && Number.isFinite(filters.year)) {
      const { dateFrom, dateTo } = buildDateRange(filters.year, filters.month);
      query = query.gte('created_at', dateFrom).lt('created_at', dateTo);
    }

    const { data, error } = await query;
    if (error) throwDbError(error);
    return data ?? [];
  }

  /** Detalle de una orden del usuario. */
  async getOrderById(userId: string, orderId: string) {
    const { data, error } = await this.supabase
      .from('payment_orders')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Orden no encontrada');
    }

    return data;
  }

  /**
   * El usuario actualiza campos editables de su orden.
   * Solo permite campos seguros (supporting_document_url, notes)
   * y solo en estados tempranos (created, waiting_deposit).
   */
  async updateOrderByUser(
    userId: string,
    orderId: string,
    dto: Record<string, unknown>,
  ) {
    const EDITABLE_STATUSES = ['created', 'waiting_deposit'];
    const ALLOWED_FIELDS = ['supporting_document_url', 'notes'];

    const { data: order, error: fetchErr } = await this.supabase
      .from('payment_orders')
      .select('id, status')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (fetchErr || !order) {
      throw new NotFoundException('Orden no encontrada');
    }

    if (!EDITABLE_STATUSES.includes(order.status)) {
      throw new BadRequestException(
        `No se puede modificar una orden en estado "${order.status}"`,
      );
    }

    // Filtrar a solo campos permitidos
    const safeUpdate: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in dto) {
        safeUpdate[key] = dto[key];
      }
    }

    if (Object.keys(safeUpdate).length === 0) {
      throw new BadRequestException(
        'No se proporcionaron campos válidos para actualizar',
      );
    }

    const { data, error } = await this.supabase
      .from('payment_orders')
      .update(safeUpdate)
      .eq('id', orderId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throwDbError(error);

    this.logger.log(
      `📝 Orden ${orderId} actualizada por usuario: ${Object.keys(safeUpdate).join(', ')}`,
    );
    return data;
  }

  /** El usuario confirma que realizó el depósito (sube comprobante). */
  async confirmDeposit(
    userId: string,
    orderId: string,
    dto: ConfirmDepositDto,
  ) {
    const { data: order, error: fetchErr } = await this.supabase
      .from('payment_orders')
      .select('id, user_id, status, requires_psav, notes')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (fetchErr || !order) throw new NotFoundException('Orden no encontrada');

    if (order.status !== 'waiting_deposit') {
      throw new BadRequestException(
        `No se puede confirmar depósito en estado "${order.status}"`,
      );
    }

    const { data: updated, error } = await this.supabase
      .from('payment_orders')
      .update({
        status: 'deposit_received',
        deposit_proof_url: dto.deposit_proof_url,
        notes: dto.notes
          ? `${order.notes ?? ''}\n[USER] ${dto.notes}`.trim()
          : undefined,
      })
      .eq('id', orderId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throwDbError(error);

    // Notificar a admins que hay un depósito por revisar
    const { data: admins } = await this.supabase
      .from('profiles')
      .select('id')
      .in('role', ['staff', 'admin', 'super_admin'])
      .eq('is_active', true)
      .limit(5);

    if (admins?.length) {
      const notifications = admins.map((admin) => ({
        user_id: admin.id,
        type: 'system',
        title: 'Nuevo Depósito por Verificar',
        message: `Orden ${orderId} tiene comprobante de depósito pendiente de revisión`,
        reference_type: 'payment_order',
        reference_id: orderId,
      }));
      await this.supabase.from('notifications').insert(notifications);
    }

    // Notificar al usuario y al staff del cambio de estado.
    // Incluimos las URLs de documentos para que la pestaña "Documentos" del detalle
    // del staff muestre el comprobante recién subido en vivo, sin recargar.
    this.ordersGateway.emitOrderUpdated(updated.user_id, {
      id: updated.id,
      user_id: updated.user_id,
      status: updated.status,
      flow_type: updated.flow_type,
      updated_at: new Date().toISOString(),
      deposit_proof_url: updated.deposit_proof_url,
      evidence_url: updated.evidence_url ?? null,
      supporting_document_url: updated.supporting_document_url ?? null,
    });

    return updated;
  }

  /** El usuario cancela su orden (solo si está en waiting_deposit). */
  async cancelOrder(userId: string, orderId: string) {
    const { data: order } = await this.supabase
      .from('payment_orders')
      .select(
        'id, user_id, status, flow_type, amount, fee_amount, currency, wallet_id, bridge_transfer_id',
      )
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (!order) throw new NotFoundException('Orden no encontrada');

    const cancellableStatuses = ['created', 'waiting_deposit'];
    if (!cancellableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `No se puede cancelar una orden en estado "${order.status}"`,
      );
    }

    // 0. Cancelar el transfer en Bridge (si existe y está en awaiting_funds)
    // Bridge solo permite DELETE cuando el transfer está en awaiting_funds.
    // Si falla (transfer ya procesado, Bridge caído, etc.) no bloqueamos
    // la cancelación local — el usuario no debe quedar atrapado.
    if (order.bridge_transfer_id) {
      try {
        await this.bridgeApi.delete(
          `/v0/transfers/${order.bridge_transfer_id}`,
        );
        this.logger.log(
          `🗑️ Transfer Bridge cancelado: ${order.bridge_transfer_id} (orden ${orderId})`,
        );
      } catch (err: any) {
        // No lanzar — la cancelación en Guira debe proseguir
        this.logger.warn(
          `⚠️ No se pudo cancelar transfer Bridge ${order.bridge_transfer_id}: ${err?.message ?? err}`,
        );
      }

      // Actualizar estado en bridge_transfers local
      await this.supabase
        .from('bridge_transfers')
        .update({ status: 'cancelled', bridge_state: 'canceled' })
        .eq('bridge_transfer_id', order.bridge_transfer_id);
    }

    // 1. Manejar ledger entries 'pending' de esta orden
    // NOTA: el check constraint de ledger_entries solo acepta: pending | settled | failed | reversed
    // 'reversed' es el estado correcto para entradas canceladas por el usuario (no error técnico).
    const { data: pendingLedgers } = await this.supabase
      .from('ledger_entries')
      .update({ status: 'reversed' })
      .eq('reference_type', 'payment_order')
      .eq('reference_id', orderId)
      .eq('status', 'pending')
      .select('amount, type');

    if (pendingLedgers && pendingLedgers.length > 0) {
      // Liberar saldos reservados asociados a debitos pendientes
      const totalToRelease = pendingLedgers
        .filter((l) => l.type === 'debit')
        .reduce((sum, l) => sum + parseFloat(l.amount), 0);

      if (totalToRelease > 0) {
        await this.supabase.rpc('release_reserved_balance', {
          p_user_id: userId,
          p_currency: (order.currency ?? 'USDC').toUpperCase(),
          p_amount: totalToRelease,
        });

        this.logger.log(
          `💰 Reserva liberada para orden cancelada: ${totalToRelease} ${order.currency}`,
        );
      }
    }

    // 2. Manejar ledgers 'settled' (es decir, el balance ya fue deducto definitivamente)
    // Para devoluciones en este punto, necesitamos emitir un reembolso (credit).
    const { data: settledLedgers } = await this.supabase
      .from('ledger_entries')
      .select('amount, type')
      .eq('reference_type', 'payment_order')
      .eq('reference_id', orderId)
      .eq('status', 'settled')
      .eq('type', 'debit');

    if (settledLedgers && settledLedgers.length > 0 && order.wallet_id) {
      const totalToRefund = settledLedgers.reduce(
        (sum, l) => sum + parseFloat(l.amount),
        0,
      );

      if (totalToRefund > 0) {
        await this.supabase.from('ledger_entries').insert({
          wallet_id: order.wallet_id,
          type: 'credit',
          amount: totalToRefund,
          currency: order.currency,
          status: 'settled',
          reference_type: 'payment_order',
          reference_id: orderId,
          description: `Reembolso por orden cancelada`,
        });

        this.logger.log(
          `💰 Reembolso emitido para orden cancelada: ${totalToRefund} ${order.currency}`,
        );
      }
    }

    const { data: updated, error } = await this.supabase
      .from('payment_orders')
      .update({ status: 'cancelled' })
      .eq('id', orderId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throwDbError(error);

    // Notificar al usuario y al staff del cambio de estado
    this.ordersGateway.emitOrderUpdated(updated.user_id, {
      id: updated.id,
      user_id: updated.user_id,
      status: updated.status,
      flow_type: updated.flow_type,
      updated_at: new Date().toISOString(),
    });

    return updated;
  }

  // ── Flujos del usuario para mapa del dashboard ──

  /** Flujos interbank del usuario agrupados por moneda — alimenta el mapa del dashboard. */
  async getMyFlowStats(userId: string, month?: string) {
    let query = this.supabase
      .from('payment_orders')
      .select('flow_type, destination_currency, currency, amount, created_at')
      .eq('user_id', userId)
      .eq('flow_category', 'interbank')
      .in('flow_type', ['bolivia_to_world', 'world_to_bolivia'])
      .eq('status', 'completed');

    if (month) {
      const start = new Date(`${month}-01T00:00:00.000Z`);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      query = query
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString());
    }

    const { data, error } = await query;
    if (error) throwDbError(error);

    const rows = data ?? [];

    const buckets = new Map<
      string,
      {
        flow_type: string;
        destination_currency: string;
        currency: string;
        transaction_count: number;
        total_amount: number;
      }
    >();

    for (const row of rows) {
      const destCurrency = (row.destination_currency ?? '').toUpperCase();
      const srcCurrency = (row.currency ?? '').toUpperCase();
      const key = `${row.flow_type}|${destCurrency}|${srcCurrency}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.transaction_count++;
        existing.total_amount += parseFloat(row.amount ?? 0);
      } else {
        buckets.set(key, {
          flow_type: row.flow_type,
          destination_currency: destCurrency,
          currency: srcCurrency,
          transaction_count: 1,
          total_amount: parseFloat(row.amount ?? 0),
        });
      }
    }

    return Array.from(buckets.values());
  }

  /** Meses con transacciones interbank completadas del usuario. */
  async getMyFlowMonths(userId: string) {
    const { data, error } = await this.supabase
      .from('payment_orders')
      .select('created_at')
      .eq('user_id', userId)
      .eq('flow_category', 'interbank')
      .in('flow_type', ['bolivia_to_world', 'world_to_bolivia'])
      .eq('status', 'completed')
      .order('created_at', { ascending: false });

    if (error) throwDbError(error);

    const months = new Set<string>();
    for (const row of data ?? []) {
      if (row.created_at) {
        const d = new Date(row.created_at);
        months.add(
          `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        );
      }
    }

    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }

  // ═══════════════════════════════════════════════
  //  ADMIN OPERATIONS
  // ═══════════════════════════════════════════════

  async listAllOrders(filters: {
    status?: string;
    flow_type?: string;
    flow_category?: string;
    requires_psav?: boolean;
    user_id?: string;
    from_date?: string;
    to_date?: string;
    q?: string;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 50, 100);
    const offset = (page - 1) * limit;

    // Embebemos profiles (FK payment_orders_user_id_fkey → profiles.id) para que
    // cada orden traiga el nombre/email del cliente: con paginación ya no podemos
    // resolverlo contra un mapa de usuarios precargado en el frontend.
    let query = this.supabase
      .from('payment_orders')
      .select(
        `*, suppliers(id, name), profiles!payment_orders_user_id_fkey(full_name, email)`,
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.flow_type) query = query.eq('flow_type', filters.flow_type);
    if (filters.flow_category)
      query = query.eq('flow_category', filters.flow_category);
    if (filters.requires_psav !== undefined)
      query = query.eq('requires_psav', filters.requires_psav);
    if (filters.user_id) query = query.eq('user_id', filters.user_id);
    if (filters.from_date) query = query.gte('created_at', filters.from_date);
    if (filters.to_date) query = query.lte('created_at', filters.to_date);

    // Búsqueda de texto libre (q): combina columnas propias de la orden con el
    // nombre/email del cliente. Se sanea el término para no romper la gramática
    // de filtros de PostgREST ni permitir inyección en `.or()`.
    if (filters.q?.trim()) {
      const term = filters.q
        .trim()
        .slice(0, 100)
        .replace(/[,()%*:]/g, ' ')
        .trim();
      if (term) {
        const orFilters: string[] = [
          `status.ilike.%${term}%`,
          `flow_type.ilike.%${term}%`,
          `currency.ilike.%${term}%`,
          `destination_currency.ilike.%${term}%`,
        ];
        // PostgREST's or() parser does not support ::cast syntax, so id and
        // profile matches are pre-resolved and added as in() conditions instead.
        // El match por id usa la función search_payment_order_ids (ver
        // migración 20260608): `id` es uuid y Postgres no tiene operador
        // ilike para ese tipo, así que el cast a text se resuelve dentro de
        // la función SQL en vez de depender de la sintaxis cast-en-filtro
        // del cliente PostgREST/JS (que fallaba en silencio).
        const [
          { data: matchedProfiles, error: profilesError },
          { data: matchedOrderIds, error: orderIdsError },
        ] = await Promise.all([
          this.supabase
            .from('profiles')
            .select('id')
            .or(`full_name.ilike.%${term}%,email.ilike.%${term}%`)
            .limit(50),
          this.supabase.rpc('search_payment_order_ids', { term }),
        ]);
        if (profilesError)
          this.logger.warn(
            `listAllOrders → fallo buscando perfiles por "${term}": ${profilesError.message}`,
          );
        if (orderIdsError)
          this.logger.warn(
            `listAllOrders → fallo buscando ids por "${term}": ${orderIdsError.message}`,
          );
        const userIds = (matchedProfiles ?? []).map((p) => p.id);
        if (userIds.length) orFilters.push(`user_id.in.(${userIds.join(',')})`);
        const orderIds = (matchedOrderIds ?? []).map(
          (o: { id: string }) => o.id,
        );
        if (orderIds.length) orFilters.push(`id.in.(${orderIds.join(',')})`);

        query = query.or(orFilters.join(','));
      }
    }

    const { data, count, error } = await query;
    this.logger.debug(
      `listAllOrders → rows=${data?.length ?? 'null'} count=${count ?? 'null'} error=${error ? JSON.stringify(error) : 'none'}`,
    );
    if (error) throwDbError(error);
    return { data: data ?? [], total: count ?? 0, page, limit };
  }

  async getOrderStats() {
    const { data: allActive } = await this.supabase
      .from('payment_orders')
      .select('status, requires_psav')
      .not('status', 'in', '("completed","failed","cancelled")');

    const rows = allActive ?? [];

    return {
      waiting_deposit: rows.filter((r) => r.status === 'waiting_deposit')
        .length,
      deposit_received: rows.filter((r) => r.status === 'deposit_received')
        .length,
      processing: rows.filter((r) => r.status === 'processing').length,
      sent: rows.filter((r) => r.status === 'sent').length,
      psav_pending: rows.filter(
        (r) =>
          r.requires_psav &&
          ['waiting_deposit', 'deposit_received'].includes(r.status),
      ).length,
    };
  }

  async getGlobalFlowStats(month?: string) {
    let query = this.supabase
      .from('payment_orders')
      .select('flow_type, destination_currency, currency, amount, created_at')
      .eq('flow_category', 'interbank')
      .in('flow_type', ['bolivia_to_world', 'world_to_bolivia'])
      .eq('status', 'completed');

    if (month) {
      const start = new Date(`${month}-01T00:00:00.000Z`);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);
      query = query
        .gte('created_at', start.toISOString())
        .lt('created_at', end.toISOString());
    }

    const { data, error } = await query;
    if (error) throwDbError(error);

    const rows = data ?? [];

    // Agregar por (flow_type, destination_currency, currency)
    const buckets = new Map<
      string,
      {
        flow_type: string;
        destination_currency: string;
        currency: string;
        transaction_count: number;
        total_amount: number;
      }
    >();

    for (const row of rows) {
      const destCurrency = (row.destination_currency ?? '').toUpperCase();
      const srcCurrency = (row.currency ?? '').toUpperCase();
      const key = `${row.flow_type}|${destCurrency}|${srcCurrency}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.transaction_count++;
        existing.total_amount += parseFloat(row.amount ?? 0);
      } else {
        buckets.set(key, {
          flow_type: row.flow_type,
          destination_currency: destCurrency,
          currency: srcCurrency,
          transaction_count: 1,
          total_amount: parseFloat(row.amount ?? 0),
        });
      }
    }

    return Array.from(buckets.values());
  }

  async getGlobalFlowMonths() {
    const { data, error } = await this.supabase
      .from('payment_orders')
      .select('created_at')
      .eq('flow_category', 'interbank')
      .in('flow_type', ['bolivia_to_world', 'world_to_bolivia'])
      .eq('status', 'completed')
      .order('created_at', { ascending: false });

    if (error) throwDbError(error);

    const months = new Set<string>();
    for (const row of data ?? []) {
      if (row.created_at) {
        const d = new Date(row.created_at);
        months.add(
          `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
        );
      }
    }

    return Array.from(months).sort((a, b) => b.localeCompare(a));
  }

  async approveOrder(orderId: string, actorId: string, dto: ApproveOrderDto) {
    const { data: order } = await this.supabase
      .from('payment_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (!order) throw new NotFoundException('Orden no encontrada');
    if (order.status !== 'deposit_received') {
      throw new BadRequestException(
        `No se puede aprobar una orden en estado "${order.status}". Requerido: "deposit_received"`,
      );
    }
    if (!order.requires_psav) {
      throw new BadRequestException('Esta orden no requiere aprobación manual');
    }

    // ── Cotización CONGELADA al crear el expediente ──
    // La aprobación es SOLO una transición de estado: no recalcula ni acepta
    // cambios de tipo de cambio, fee o monto destino. El cliente creó el
    // expediente con una cotización concreta y esa es la que se honra
    // (transparencia). No se lee ningún valor financiero del DTO.
    const exchangeRate = order.exchange_rate_applied
      ? parseFloat(order.exchange_rate_applied)
      : null;

    const amountDestination =
      order.amount_destination != null
        ? parseFloat(order.amount_destination)
        : null;

    const isBobOut = [
      'bolivia_to_world',
      'bolivia_to_wallet',
      'fiat_bo_to_bridge_wallet',
    ].includes(order.flow_type ?? '');

    // Monto bruto (USDC) que el staff debe depositar en la liquidation address,
    // derivado de los valores congelados de la orden. Bridge cobra el fee como
    // custom_developer_fee_percent de la LA, así que el depósito es el bruto.
    const amountToDeposit =
      exchangeRate && isBobOut
        ? parseFloat((parseFloat(order.amount) / exchangeRate).toFixed(2))
        : amountDestination;

    const { data: updated, error } = await this.supabase
      .from('payment_orders')
      .update({
        status: 'processing',
        approved_by: actorId,
        approved_at: new Date().toISOString(),
        // exchange_rate_applied, amount_destination y fee_amount NO se tocan:
        // quedaron congelados al crear el expediente para garantizar que el
        // cliente reciba exactamente lo cotizado.
        notes: dto.notes
          ? `${order.notes ?? ''}\n[ADMIN] ${dto.notes}`.trim()
          : order.notes,
      })
      .eq('id', orderId)
      .select()
      .single();

    if (error) throwDbError(error);

    // Audit log
    const approveActorRole = await this.getActorRole(actorId);
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: approveActorRole,
      action: 'APPROVE_PAYMENT_ORDER',
      table_name: 'payment_orders',
      record_id: orderId,
      previous_values: { status: 'deposit_received' },
      new_values: {
        status: 'processing',
        exchange_rate_applied: exchangeRate,
        amount_destination: amountDestination,
      },
      reason: dto.notes ?? '',
      source: 'admin_panel',
    });

    await this.supabase.from('activity_logs').insert({
      user_id: order.user_id,
      action: 'PAYMENT_ORDER_APPROVED',
      description: `Orden ${orderId} (${order.flow_type}) aprobada por admin`,
    });

    // Notificación al usuario
    await this.supabase.from('notifications').insert({
      user_id: order.user_id,
      type: 'financial',
      title: 'Orden Aprobada',
      message: `Tu orden de pago por ${order.amount} ${order.currency} ha sido aprobada y está siendo procesada.`,
      reference_type: 'payment_order',
      reference_id: orderId,
    });

    // ── Bolivia-to-World: flujo asistido por staff via liquidation address ──
    // NO se crea Bridge Transfer automáticamente. El staff depositará USDC manualmente
    // en la liquidation address del proveedor y el webhook drain confirmará el expediente.
    if (order.flow_type === 'bolivia_to_world') {
      // 1. Cargar supplier y su bridge_liquidation_address_id
      if (!order.supplier_id) {
        throw new BadRequestException(
          'La orden bolivia_to_world no tiene supplier_id asignado. No se puede resolver la liquidation address.',
        );
      }

      const { data: supplier } = await this.supabase
        .from('suppliers')
        .select('id, name, bridge_liquidation_address_id')
        .eq('id', order.supplier_id)
        .single();

      if (!supplier?.bridge_liquidation_address_id) {
        throw new BadRequestException(
          `El proveedor "${supplier?.name ?? order.supplier_id}" no tiene liquidation address configurada en Bridge.`,
        );
      }

      // 2. Consultar bridge_liquidation_addresses para obtener datos de depósito
      const { data: liqAddr } = await this.supabase
        .from('bridge_liquidation_addresses')
        .select(
          'id, bridge_liquidation_address_id, chain, currency, address, destination_payment_rail, destination_currency, destination_external_account_id, destination_address, developer_fee_percent',
        )
        .eq(
          'bridge_liquidation_address_id',
          supplier.bridge_liquidation_address_id,
        )
        .single();

      if (!liqAddr) {
        throw new BadRequestException(
          `Liquidation address "${supplier.bridge_liquidation_address_id}" no encontrada en la base de datos.`,
        );
      }

      // 3. Persistir datos de liquidation como instrucciones de depósito para el staff
      const liquidationInstructions = {
        type: 'liquidation_address',
        bridge_liquidation_address_id: liqAddr.bridge_liquidation_address_id,
        to_address: liqAddr.address,
        chain: liqAddr.chain,
        currency: liqAddr.currency,
        payment_rail: liqAddr.chain,
        destination_payment_rail: liqAddr.destination_payment_rail,
        destination_currency: liqAddr.destination_currency,
        destination_external_account_id:
          liqAddr.destination_external_account_id,
        destination_address: liqAddr.destination_address,
        developer_fee_percent: liqAddr.developer_fee_percent,
        fee_source: 'liquidation_address',
        supplier_name: supplier.name,
        amount_to_deposit: amountToDeposit,
      };

      // Solo se persisten las instrucciones operativas de depósito. El fee
      // (bridge_liquidation_fee_percent, fee_source) y el bridge_liquidation_address_id
      // quedaron fijados al crear el expediente y NO se reescriben aquí.
      await this.supabase
        .from('payment_orders')
        .update({
          bridge_source_deposit_instructions: liquidationInstructions,
        })
        .eq('id', orderId);

      // Propagar cambios al objeto que se retorna
      updated.bridge_source_deposit_instructions = liquidationInstructions;

      this.logger.log(
        `📋 Orden bolivia_to_world ${orderId} en processing — staff debe depositar ` +
          `${amountToDeposit ?? 'N/A'} ${liqAddr.currency} en liquidation address ${liqAddr.address} ` +
          `(chain: ${liqAddr.chain}, proveedor: ${supplier.name})`,
      );
    }

    // ── Bolivia-to-Wallet: flujo asistido por staff via liquidation address (crypto) ──
    // Mismo patrón que bolivia_to_world pero el matching del drain será por to_address
    if (order.flow_type === 'bolivia_to_wallet') {
      if (!order.supplier_id) {
        throw new BadRequestException(
          'La orden bolivia_to_wallet no tiene supplier_id asignado. No se puede resolver la liquidation address.',
        );
      }

      const { data: walletSupplier } = await this.supabase
        .from('suppliers')
        .select('id, name, bridge_liquidation_address_id')
        .eq('id', order.supplier_id)
        .single();

      if (!walletSupplier?.bridge_liquidation_address_id) {
        throw new BadRequestException(
          `El proveedor "${walletSupplier?.name ?? order.supplier_id}" no tiene liquidation address configurada en Bridge.`,
        );
      }

      const { data: walletLiqAddr } = await this.supabase
        .from('bridge_liquidation_addresses')
        .select(
          'id, bridge_liquidation_address_id, chain, currency, address, destination_payment_rail, destination_currency, destination_address, developer_fee_percent',
        )
        .eq(
          'bridge_liquidation_address_id',
          walletSupplier.bridge_liquidation_address_id,
        )
        .single();

      if (!walletLiqAddr) {
        throw new BadRequestException(
          `Liquidation address "${walletSupplier.bridge_liquidation_address_id}" no encontrada en la base de datos.`,
        );
      }

      const walletLiquidationInstructions = {
        type: 'liquidation_address',
        bridge_liquidation_address_id:
          walletLiqAddr.bridge_liquidation_address_id,
        to_address: walletLiqAddr.address,
        chain: walletLiqAddr.chain,
        currency: walletLiqAddr.currency,
        payment_rail: walletLiqAddr.chain,
        destination_payment_rail: walletLiqAddr.destination_payment_rail,
        destination_currency: walletLiqAddr.destination_currency,
        destination_address: walletLiqAddr.destination_address,
        developer_fee_percent: walletLiqAddr.developer_fee_percent,
        fee_source: 'liquidation_address',
        supplier_name: walletSupplier.name,
        amount_to_deposit: amountToDeposit,
      };

      // Solo se persisten las instrucciones operativas de depósito. El fee y el
      // bridge_liquidation_address_id quedaron fijados al crear el expediente.
      await this.supabase
        .from('payment_orders')
        .update({
          bridge_source_deposit_instructions: walletLiquidationInstructions,
        })
        .eq('id', orderId);

      updated.bridge_source_deposit_instructions =
        walletLiquidationInstructions;

      this.logger.log(
        `📋 Orden bolivia_to_wallet ${orderId} en processing — staff debe depositar ` +
          `${amountToDeposit ?? 'N/A'} ${walletLiqAddr.currency} en liquidation address ${walletLiqAddr.address} ` +
          `(chain: ${walletLiqAddr.chain}, proveedor: ${walletSupplier.name})`,
      );
    }

    // Notificar al usuario y al staff del cambio de estado (con campos extra para staff)
    this.ordersGateway.emitOrderUpdated(updated.user_id, {
      id: updated.id,
      user_id: updated.user_id,
      status: updated.status,
      flow_type: updated.flow_type,
      updated_at: new Date().toISOString(),
      exchange_rate_applied: updated.exchange_rate_applied,
      amount_destination: updated.amount_destination,
      bridge_source_deposit_instructions:
        updated.bridge_source_deposit_instructions,
    });

    return updated;
  }

  async markSent(orderId: string, actorId: string, dto: MarkSentDto) {
    const { data: order } = await this.supabase
      .from('payment_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (!order) throw new NotFoundException('Orden no encontrada');
    if (
      [
        'fiat_bo_to_bridge_wallet',
        'crypto_to_bridge_wallet',
        'bolivia_to_world',
        'bolivia_to_wallet',
      ].includes(order.flow_type ?? '')
    ) {
      throw new BadRequestException(
        'Este flujo se completa automáticamente por webhook de Bridge. markSent no está disponible.',
      );
    }
    if (order.status !== 'processing') {
      throw new BadRequestException(
        `No se puede marcar como enviada una orden en estado "${order.status}"`,
      );
    }

    const { data: updated, error } = await this.supabase
      .from('payment_orders')
      .update({
        status: 'sent',
        tx_hash: dto.tx_hash,
        provider_reference: dto.provider_reference,
        notes: dto.notes
          ? `${order.notes ?? ''}\n[ADMIN] ${dto.notes}`.trim()
          : order.notes,
      })
      .eq('id', orderId)
      .select()
      .single();

    if (error) throwDbError(error);

    const markSentActorRole = await this.getActorRole(actorId);
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: markSentActorRole,
      action: 'MARK_SENT_PAYMENT_ORDER',
      table_name: 'payment_orders',
      record_id: orderId,
      new_values: { status: 'sent', tx_hash: dto.tx_hash },
      reason: dto.notes ?? '',
      source: 'admin_panel',
    });

    await this.supabase.from('activity_logs').insert({
      user_id: order.user_id,
      action: 'PAYMENT_ORDER_SENT',
      description: `Orden ${orderId} (${order.flow_type}) marcada como enviada por admin`,
    });

    await this.supabase.from('notifications').insert({
      user_id: order.user_id,
      type: 'financial',
      title: 'Fondos Enviados',
      message: `Los fondos de tu orden han sido enviados. Referencia: ${dto.tx_hash}`,
      reference_type: 'payment_order',
      reference_id: orderId,
    });

    // Notificar al usuario y al staff del cambio de estado
    this.ordersGateway.emitOrderUpdated(updated.user_id, {
      id: updated.id,
      user_id: updated.user_id,
      status: updated.status,
      flow_type: updated.flow_type,
      updated_at: new Date().toISOString(),
    });

    return updated;
  }

  async completeOrder(orderId: string, actorId: string, dto: CompleteOrderDto) {
    const { data: order } = await this.supabase
      .from('payment_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (!order) throw new NotFoundException('Orden no encontrada');
    if (order.status !== 'sent') {
      throw new BadRequestException(
        `No se puede completar una orden en estado "${order.status}"`,
      );
    }

    const { data: updated, error } = await this.supabase
      .from('payment_orders')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        receipt_url: dto.receipt_url,
        notes: dto.notes
          ? `${order.notes ?? ''}\n[ADMIN] ${dto.notes}`.trim()
          : order.notes,
      })
      .eq('id', orderId)
      .select()
      .single();

    if (error) throwDbError(error);

    void this.notifyOrderFinalStatusEmail(order, 'completed');

    // Off-ramp PSAV a fiat BO — El ledger debit y la liberación de reserva
    // ahora se manejan automáticamente en el webhook transfer.complete (Tramo 1).
    // El completeOrder solo finaliza el estado de la orden tras el payout BOB (Tramo 2).

    const completeActorRole = await this.getActorRole(actorId);
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: completeActorRole,
      action: 'COMPLETE_PAYMENT_ORDER',
      table_name: 'payment_orders',
      record_id: orderId,
      new_values: { status: 'completed', receipt_url: dto.receipt_url },
      reason: dto.notes ?? '',
      source: 'admin_panel',
    });

    await this.supabase.from('notifications').insert({
      user_id: order.user_id,
      type: 'financial',
      title: 'Orden Completada',
      message: `Tu orden de pago ha sido completada exitosamente.`,
      reference_type: 'payment_order',
      reference_id: orderId,
    });

    await this.supabase.from('activity_logs').insert({
      user_id: order.user_id,
      action: 'PAYMENT_ORDER_COMPLETED',
      description: `Orden ${orderId} (${order.flow_type}) completada por admin`,
    });

    // Notificar al usuario y al staff del cambio de estado
    this.ordersGateway.emitOrderUpdated(updated.user_id, {
      id: updated.id,
      user_id: updated.user_id,
      status: updated.status,
      flow_type: updated.flow_type,
      updated_at: new Date().toISOString(),
    });

    return updated;
  }

  async failOrder(orderId: string, actorId: string, dto: FailOrderDto) {
    const { data: order } = await this.supabase
      .from('payment_orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (!order) throw new NotFoundException('Orden no encontrada');
    if (
      [
        'completed',
        'failed',
        'cancelled',
        'swept_external',
        'refunded',
      ].includes(order.status)
    ) {
      throw new BadRequestException(
        `No se puede fallar una orden en estado terminal "${order.status}"`,
      );
    }

    const { data: updated, error } = await this.supabase
      .from('payment_orders')
      .update({
        status: 'failed',
        failure_reason: dto.reason,
      })
      .eq('id', orderId)
      .select()
      .single();

    if (error) throwDbError(error);

    void this.notifyOrderFinalStatusEmail(order, 'failed');

    // 1. Manejar ledger entries 'pending' de esta orden
    const { data: pendingLedgers } = await this.supabase
      .from('ledger_entries')
      .update({ status: 'failed' })
      .eq('reference_type', 'payment_order')
      .eq('reference_id', orderId)
      .eq('status', 'pending')
      .select('amount, type');

    if (pendingLedgers && pendingLedgers.length > 0) {
      // Liberar saldos reservados asociados a debitos pendientes
      const totalToRelease = pendingLedgers
        .filter((l) => l.type === 'debit')
        .reduce((sum, l) => sum + parseFloat(l.amount), 0);

      if (totalToRelease > 0) {
        await this.supabase.rpc('release_reserved_balance', {
          p_user_id: order.user_id,
          p_currency: (order.currency ?? 'USDC').toUpperCase(),
          p_amount: totalToRelease,
        });

        this.logger.log(
          `💰 Reserva liberada para orden fallida: ${totalToRelease} ${order.currency}`,
        );
      }
    }

    // 2. Manejar ledgers 'settled' (es decir, el balance ya fue deducto definitivamente)
    // Para devoluciones en este punto, necesitamos emitir un reembolso (credit).
    const { data: settledLedgers } = await this.supabase
      .from('ledger_entries')
      .select('amount, type')
      .eq('reference_type', 'payment_order')
      .eq('reference_id', orderId)
      .eq('status', 'settled')
      .eq('type', 'debit');

    if (settledLedgers && settledLedgers.length > 0 && order.wallet_id) {
      const totalToRefund = settledLedgers.reduce(
        (sum, l) => sum + parseFloat(l.amount),
        0,
      );

      if (totalToRefund > 0) {
        await this.supabase.from('ledger_entries').insert({
          wallet_id: order.wallet_id,
          type: 'credit',
          amount: totalToRefund,
          currency: order.currency,
          status: 'settled',
          reference_type: 'payment_order',
          reference_id: orderId,
          description: `Reembolso por orden fallida/rechazada`,
        });

        this.logger.log(
          `💰 Reembolso emitido para orden fallida: ${totalToRefund} ${order.currency}`,
        );
      }
    }

    const failActorRole = await this.getActorRole(actorId);
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: failActorRole,
      action: 'FAIL_PAYMENT_ORDER',
      table_name: 'payment_orders',
      record_id: orderId,
      new_values: { status: 'failed', failure_reason: dto.reason },
      reason: dto.reason,
      source: 'admin_panel',
    });

    if (dto.notify_user !== false) {
      await this.supabase.from('notifications').insert({
        user_id: order.user_id,
        type: 'alert',
        title: 'Orden de Pago Fallida',
        message: `Tu orden de pago no pudo ser procesada. Motivo: ${dto.reason}`,
        reference_type: 'payment_order',
        reference_id: orderId,
      });
    }

    await this.supabase.from('activity_logs').insert({
      user_id: order.user_id,
      action: 'PAYMENT_ORDER_FAILED',
      description: `Orden ${orderId} (${order.flow_type}) marcada como fallida por admin. Motivo: ${dto.reason}`,
    });

    // Notificar al usuario y al staff del cambio de estado
    this.ordersGateway.emitOrderUpdated(updated.user_id, {
      id: updated.id,
      user_id: updated.user_id,
      status: updated.status,
      flow_type: updated.flow_type,
      updated_at: new Date().toISOString(),
    });

    return updated;
  }

  // ═══════════════════════════════════════════════
  //  CUSTOMER LIMIT OVERRIDES — CRUD Admin
  // ═══════════════════════════════════════════════

  /** Lista todos los overrides de límite de un usuario. */
  async getLimitOverrides(userId: string) {
    const { data, error } = await this.supabase
      .from('customer_limit_overrides')
      .select('*')
      .eq('user_id', userId)
      .order('flow_type');

    if (error) throwDbError(error);
    return data ?? [];
  }

  /** Crea un override de límite para un cliente VIP. */
  async createLimitOverride(
    dto: {
      user_id: string;
      flow_type: string;
      min_usd?: number | null;
      max_usd?: number | null;
      valid_from?: string;
      valid_until?: string;
      notes?: string;
    },
    actorId: string,
  ) {
    // Verificar que no exista ya un override activo para (user_id, flow_type)
    const today = new Date().toISOString().split('T')[0];
    const { data: conflict } = await this.supabase
      .from('customer_limit_overrides')
      .select('id')
      .eq('user_id', dto.user_id)
      .eq('flow_type', dto.flow_type)
      .eq('is_active', true)
      .maybeSingle();

    if (conflict) {
      throw new BadRequestException(
        `Ya existe un override activo para el flujo "${dto.flow_type}". Desactívalo o elimínalo primero.`,
      );
    }

    const { data, error } = await this.supabase
      .from('customer_limit_overrides')
      .insert({
        ...dto,
        valid_from: dto.valid_from ?? today,
        is_active: true,
        created_by: actorId,
      })
      .select()
      .single();

    if (error) throwDbError(error);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'admin',
      action: 'limit_override_created',
      table_name: 'customer_limit_overrides',
      record_id: data.id,
      new_values: {
        user_id: dto.user_id,
        flow_type: dto.flow_type,
        min_usd: dto.min_usd,
        max_usd: dto.max_usd,
        valid_from: dto.valid_from ?? today,
      },
      source: 'admin_panel',
    });

    return data;
  }

  /** Actualiza un override de límite existente. */
  async updateLimitOverride(
    overrideId: string,
    dto: {
      min_usd?: number | null;
      max_usd?: number | null;
      is_active?: boolean;
      valid_until?: string;
      notes?: string;
    },
    actorId: string,
  ) {
    const { data: current, error: findError } = await this.supabase
      .from('customer_limit_overrides')
      .select('*')
      .eq('id', overrideId)
      .single();

    if (findError || !current)
      throw new NotFoundException('Override de límite no encontrado');

    // Si se está activando, verificar que no haya otro activo para el mismo (user_id, flow_type)
    if (dto.is_active === true && !current.is_active) {
      const { data: conflict } = await this.supabase
        .from('customer_limit_overrides')
        .select('id')
        .eq('user_id', current.user_id)
        .eq('flow_type', current.flow_type)
        .eq('is_active', true)
        .neq('id', overrideId)
        .maybeSingle();

      if (conflict) {
        throw new BadRequestException(
          `Ya existe un override activo para el flujo "${current.flow_type}". Desactívalo primero.`,
        );
      }
    }

    const { data, error } = await this.supabase
      .from('customer_limit_overrides')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', overrideId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        'No se pudo actualizar el override de límite',
      );

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'admin',
      action: 'limit_override_updated',
      table_name: 'customer_limit_overrides',
      record_id: overrideId,
      previous_values: {
        min_usd: current.min_usd,
        max_usd: current.max_usd,
        is_active: current.is_active,
      },
      new_values: {
        user_id: current.user_id,
        flow_type: current.flow_type,
        updated: dto,
      },
      source: 'admin_panel',
    });

    return data;
  }

  /** Elimina permanentemente un override de límite. Solo super_admin. */
  async deleteLimitOverride(overrideId: string, actorId: string) {
    const { data: current, error: findError } = await this.supabase
      .from('customer_limit_overrides')
      .select('*')
      .eq('id', overrideId)
      .single();

    if (findError || !current)
      throw new NotFoundException('Override de límite no encontrado');

    const { error } = await this.supabase
      .from('customer_limit_overrides')
      .delete()
      .eq('id', overrideId);

    if (error)
      throw new BadRequestException(
        'No se pudo eliminar el override de límite',
      );

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'admin',
      action: 'limit_override_deleted',
      table_name: 'customer_limit_overrides',
      record_id: overrideId,
      previous_values: {
        user_id: current.user_id,
        flow_type: current.flow_type,
        min_usd: current.min_usd,
        max_usd: current.max_usd,
      },
      source: 'admin_panel',
    });
  }

  // ── Visibilidad de flujos por país + override de staff ───────

  /** País de origen materializado del cliente (profiles.country_code). NULL si no resuelto. */
  private async getProfileCountry(userId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('profiles')
      .select('country_code')
      .eq('id', userId)
      .maybeSingle();
    return (data?.country_code as string | null) ?? null;
  }

  /** Overrides de flujo ACTIVOS de un cliente, como mapa flow_type → is_enabled. */
  private async getActiveFlowOverrides(
    userId: string,
  ): Promise<Map<string, boolean>> {
    const { data } = await this.supabase
      .from('customer_flow_overrides')
      .select('flow_type, is_enabled')
      .eq('user_id', userId)
      .eq('is_active', true);
    const map = new Map<string, boolean>();
    for (const row of data ?? []) {
      map.set(row.flow_type as string, row.is_enabled as boolean);
    }
    return map;
  }

  /**
   * Resuelve el conjunto de flow_types VISIBLES para el cliente:
   * default por país (NULL → Bolivia) y luego override de staff (prioritario).
   */
  async resolveEnabledFlows(userId: string): Promise<Set<string>> {
    const [country, overrides] = await Promise.all([
      this.getProfileCountry(userId),
      this.getActiveFlowOverrides(userId),
    ]);
    const enabled = new Set<string>(resolveDefaultFlows(country));
    for (const flow of GOVERNED_FLOWS) {
      const override = overrides.get(flow);
      if (override === undefined) continue;
      if (override) enabled.add(flow);
      else enabled.delete(flow);
    }
    return enabled;
  }

  /**
   * Barrera de seguridad: rechaza con 403 si el flujo está oculto para el cliente.
   * Solo aplica a flujos gobernados; los fuera de alcance pasan sin gating.
   */
  async assertFlowEnabled(userId: string, flowType: string): Promise<void> {
    if (!isGovernedFlow(flowType)) return;
    const enabled = await this.resolveEnabledFlows(userId);
    if (!enabled.has(flowType)) {
      throw new ForbiddenException(
        `El flujo "${flowType}" no está habilitado para tu cuenta. Contacta a soporte si crees que es un error.`,
      );
    }
  }

  /**
   * Detalle de visibilidad para el cliente autenticado: lista de flujos
   * habilitados + desglose default/override/efectivo por flujo gobernado.
   */
  async getAvailableFlows(userId: string) {
    const [country, overrides] = await Promise.all([
      this.getProfileCountry(userId),
      this.getActiveFlowOverrides(userId),
    ]);
    const defaults = new Set(resolveDefaultFlows(country));
    const by_flow: Record<
      string,
      { default: boolean; override: boolean | null; effective: boolean }
    > = {};
    const enabled: string[] = [];
    for (const flow of GOVERNED_FLOWS) {
      const def = defaults.has(flow);
      const override = overrides.has(flow) ? overrides.get(flow)! : null;
      const effective = override === null ? def : override;
      by_flow[flow] = { default: def, override, effective };
      if (effective) enabled.push(flow);
    }
    return { country_code: country, enabled, by_flow };
  }

  /** Lista los overrides de flujo de un cliente (admin). */
  async getFlowOverrides(userId: string) {
    const { data, error } = await this.supabase
      .from('customer_flow_overrides')
      .select('*')
      .eq('user_id', userId)
      .order('flow_type');
    if (error) throwDbError(error);
    return data ?? [];
  }

  /** Crea un override de visibilidad de flujo para un cliente. */
  async createFlowOverride(
    dto: {
      user_id: string;
      flow_type: string;
      is_enabled: boolean;
      notes?: string;
    },
    actorId: string,
  ) {
    const { data: conflict } = await this.supabase
      .from('customer_flow_overrides')
      .select('id')
      .eq('user_id', dto.user_id)
      .eq('flow_type', dto.flow_type)
      .eq('is_active', true)
      .maybeSingle();

    if (conflict) {
      throw new BadRequestException(
        `Ya existe un override activo para el flujo "${dto.flow_type}". Desactívalo o elimínalo primero.`,
      );
    }

    const { data, error } = await this.supabase
      .from('customer_flow_overrides')
      .insert({
        user_id: dto.user_id,
        flow_type: dto.flow_type,
        is_enabled: dto.is_enabled,
        notes: dto.notes,
        is_active: true,
        created_by: actorId,
      })
      .select()
      .single();

    if (error) throwDbError(error);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'admin',
      action: 'flow_override_created',
      table_name: 'customer_flow_overrides',
      record_id: data.id,
      new_values: {
        user_id: dto.user_id,
        flow_type: dto.flow_type,
        is_enabled: dto.is_enabled,
      },
      source: 'admin_panel',
    });

    return data;
  }

  /** Actualiza un override de flujo (is_enabled, is_active, notes). */
  async updateFlowOverride(
    overrideId: string,
    dto: { is_enabled?: boolean; is_active?: boolean; notes?: string },
    actorId: string,
  ) {
    const { data: current, error: findError } = await this.supabase
      .from('customer_flow_overrides')
      .select('*')
      .eq('id', overrideId)
      .single();

    if (findError || !current)
      throw new NotFoundException('Override de flujo no encontrado');

    // Si se reactiva, verificar que no haya otro activo para el mismo (user_id, flow_type)
    if (dto.is_active === true && !current.is_active) {
      const { data: conflict } = await this.supabase
        .from('customer_flow_overrides')
        .select('id')
        .eq('user_id', current.user_id)
        .eq('flow_type', current.flow_type)
        .eq('is_active', true)
        .neq('id', overrideId)
        .maybeSingle();

      if (conflict) {
        throw new BadRequestException(
          `Ya existe un override activo para el flujo "${current.flow_type}". Desactívalo primero.`,
        );
      }
    }

    const { data, error } = await this.supabase
      .from('customer_flow_overrides')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', overrideId)
      .select()
      .single();

    if (error || !data)
      throw new BadRequestException(
        'No se pudo actualizar el override de flujo',
      );

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'admin',
      action: 'flow_override_updated',
      table_name: 'customer_flow_overrides',
      record_id: overrideId,
      previous_values: {
        is_enabled: current.is_enabled,
        is_active: current.is_active,
      },
      new_values: {
        user_id: current.user_id,
        flow_type: current.flow_type,
        updated: dto,
      },
      source: 'admin_panel',
    });

    return data;
  }

  /** Elimina permanentemente un override de flujo. Solo super_admin. */
  async deleteFlowOverride(overrideId: string, actorId: string) {
    const { data: current, error: findError } = await this.supabase
      .from('customer_flow_overrides')
      .select('*')
      .eq('id', overrideId)
      .single();

    if (findError || !current)
      throw new NotFoundException('Override de flujo no encontrado');

    const { error } = await this.supabase
      .from('customer_flow_overrides')
      .delete()
      .eq('id', overrideId);

    if (error)
      throw new BadRequestException('No se pudo eliminar el override de flujo');

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'admin',
      action: 'flow_override_deleted',
      table_name: 'customer_flow_overrides',
      record_id: overrideId,
      previous_values: {
        user_id: current.user_id,
        flow_type: current.flow_type,
        is_enabled: current.is_enabled,
      },
      source: 'admin_panel',
    });
  }

  // ── Aprobar revisión → crear orden ───────────────────────────

  /**
   * Llamado por el controller admin al aprobar una review request.
   * Recupera el payload guardado y llama al método de creación correspondiente
   * sin pasar reviewContext (el límite se salta porque el staff ya aprobó).
   * Para saltarlo de forma controlada, se fuerza el monto hacia el límite
   * modificando el payload temporalmente usando un override interno.
   */
  async createOrderFromReview(
    reviewId: string,
    actorId: string,
    staffNotes?: string,
  ) {
    // 1. Aprobar en la tabla (lock optimista)
    const { review, payload } = await this.orderReviewService.approveReview(
      reviewId,
      actorId,
      staffNotes,
    );

    const flowType = review.flow_type;
    const interbankFlows = [
      'bolivia_to_world',
      'bolivia_to_wallet',
      'wallet_to_wallet',
      'world_to_bolivia',
      'world_to_wallet',
    ];

    let order: Record<string, unknown>;

    // 2. Crear la orden saltando la validación de máximo (el staff ya aprobó)
    //    Se usa un método privado interno que no revisa el límite superior.
    try {
      if (interbankFlows.includes(flowType)) {
        order = await this.createInterbankOrderBypassLimit(
          review.user_id,
          payload as unknown as CreateInterbankOrderDto,
        );
      } else {
        order = await this.createWalletRampOrderBypassLimit(
          review.user_id,
          payload as unknown as CreateWalletRampOrderDto,
        );
      }
    } catch (err) {
      // Revertir la aprobación a pending_review para que pueda reintentarse
      await this.supabase
        .from('order_review_requests')
        .update({
          status: 'pending_review',
          reviewed_by: null,
          reviewed_at: null,
        })
        .eq('id', reviewId);
      await this.supabase.from('audit_logs').insert({
        performed_by: actorId,
        action: 'APPROVE_REVIEW_ROLLBACK',
        table_name: 'order_review_requests',
        new_values: {
          id: reviewId,
          status: 'pending_review',
          error: (err as Error)?.message ?? String(err),
        },
        source: 'admin_panel',
      });
      throw err;
    }

    // 3. Vincular el payment_order_id a la review
    await this.orderReviewService.linkPaymentOrder(reviewId, (order as any).id);

    // 4. Notificar al cliente
    await this.notificationsService.sendNotification({
      userId: review.user_id,
      type: NotificationType.FINANCIAL,
      title: 'Expediente aprobado',
      message: `Tu solicitud de ${review.flow_type.replace(/_/g, ' ')} por ${review.amount} ${review.currency} fue aprobada. Tu expediente está en proceso.`,
      link: `/panel/pagos/${(order as any).id}`,
      referenceType: 'payment_order',
      referenceId: (order as any).id,
    });

    return { review, order };
  }

  // Versión de createInterbankOrder que omite el check de límite máximo.
  private async createInterbankOrderBypassLimit(
    userId: string,
    dto: CreateInterbankOrderDto,
  ) {
    switch (dto.flow_type) {
      case InterbankFlowType.BOLIVIA_TO_WORLD:
        return this.createBoliviaToWorld(userId, dto);
      case InterbankFlowType.WALLET_TO_WALLET:
        return this.createWalletToWallet(userId, dto);
      case InterbankFlowType.BOLIVIA_TO_WALLET:
        return this.createBoliviaToWallet(userId, dto);
      case InterbankFlowType.WORLD_TO_BOLIVIA:
        return this.createWorldToBolivia(userId, dto);
      case InterbankFlowType.WORLD_TO_WALLET:
        return this.createWorldToWallet(userId, dto);
      default:
        throw new BadRequestException(`Flujo no soportado: ${dto.flow_type}`);
    }
  }

  // Versión de createWalletRampOrder que omite el check de límite máximo.
  private async createWalletRampOrderBypassLimit(
    userId: string,
    dto: CreateWalletRampOrderDto,
  ) {
    switch (dto.flow_type) {
      case WalletRampFlowType.FIAT_BO_TO_BRIDGE_WALLET:
        return this.createFiatBoToBridgeWallet(userId, dto);
      case WalletRampFlowType.CRYPTO_TO_BRIDGE_WALLET:
        return this.createCryptoToBridgeWallet(userId, dto);
      case WalletRampFlowType.BRIDGE_WALLET_TO_FIAT_BO:
        return this.createBridgeWalletToFiatBo(userId, dto);
      case WalletRampFlowType.BRIDGE_WALLET_TO_CRYPTO:
        return this.createBridgeWalletToCrypto(userId, dto);
      case WalletRampFlowType.BRIDGE_WALLET_TO_FIAT_US:
        return this.createBridgeWalletToFiatUs(userId, dto);
      case WalletRampFlowType.WALLET_TO_FIAT:
        return this.createWalletToFiat(userId, dto);
      default:
        throw new BadRequestException(`Flujo no soportado: ${dto.flow_type}`);
    }
  }
}

import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExchangeRatesGateway } from './exchange-rates.gateway';
import type { RateUpdatedPayload } from './exchange-rates.gateway';
import { BridgeApiClient } from '../bridge/bridge-api.client';

interface BridgeExchangeRateResponse {
  midmarket_rate: string;
  buy_rate: string;
  sell_rate: string;
}

@Injectable()
export class ExchangeRatesService {
  private readonly logger = new Logger(ExchangeRatesService.name);
  private readonly EXTERNAL_API_URL =
    'https://api-mdp-2.onrender.com/api/forex/exchange-rate/all?asset=USDT';

  /**
   * Alias de pares legacy → canónicos.
   * BOB_USDC y USDC_BOB ya no existen en DB; se redirigen a BOB_USD / USD_BOB.
   */
  private readonly PAIR_ALIASES: Record<string, string> = {
    BOB_USDC: 'BOB_USD',
    USDC_BOB: 'USD_BOB',
  };

  /** Divisas fiat de Bridge para las que se calculan pares cruzados contra BOB. */
  private readonly BRIDGE_CURRENCIES = ['eur', 'mxn', 'brl', 'cop', 'gbp'] as const;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gateway: ExchangeRatesGateway,
    private readonly bridgeApi: BridgeApiClient,
  ) {}

  /**
   * Calcula el effective_rate con precisión adaptativa por par:
   * - USD_EUR, USD_GBP: truncado a 3 decimales (sin redondeo, conservador)
   * - BOB_COP, COP_BOB: redondeado a 6 decimales (4 decimales borraba por
   *   completo el spread compra/venta, ya que ambos pares colapsaban al
   *   mismo valor 0.0029)
   * - tasas < 0.1 (resto): redondeado a 4 decimales
   * - resto: redondeado a 2 decimales
   */
  private roundEffectiveRate(value: number, pair?: string): number {
    const upperPair = (pair ?? '').toUpperCase();
    const THREE_DEC_PAIRS = ['USD_EUR', 'USD_GBP'];
    if (THREE_DEC_PAIRS.includes(upperPair)) {
      return Math.floor(value * 1000) / 1000;
    }
    const SIX_DEC_PAIRS = ['BOB_COP', 'COP_BOB'];
    if (SIX_DEC_PAIRS.includes(upperPair)) {
      const factor = 1_000_000;
      return Math.round(value * factor) / factor;
    }
    const decimals = value < 0.1 ? 4 : 2;
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  /** Construye el payload para la notificación WS sin consultar DB nuevamente. */
  private buildRateUpdatedPayload(
    pair: string,
    baseRate: number,
    spreadPercent: number,
    bridgeBuyRate: number | null = null,
    bridgeSellRate: number | null = null,
  ): RateUpdatedPayload {
    const isBobPair = pair.toUpperCase().startsWith('BOB_');
    const spreadMultiplier = isBobPair
      ? 1 + spreadPercent / 100
      : 1 - spreadPercent / 100;
    const effectiveRate = this.roundEffectiveRate(baseRate * spreadMultiplier, pair);

    return {
      pair,
      base_rate: baseRate,
      spread_percent: spreadPercent,
      effective_rate: effectiveRate,
      bridge_buy_rate: bridgeBuyRate,
      bridge_sell_rate: bridgeSellRate,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Tarea automática: sincroniza tasas cada minuto.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleCronSyncRates() {
    this.logger.log(
      'Iniciando cron job: Sincronización automática de exchange rates...',
    );
    await this.syncExternalRates('system_cron');
  }

  /**
   * Sincroniza desde el API externo (Binance P2P history).
   * Solo 2 pares canónicos:
   *   BUY  → BOB_USD = X (cuántos BOB por 1 USD)
   *   SELL → USD_BOB = Y (cuántos BOB por 1 USD)
   */
  async syncExternalRates(actorId = 'system_admin') {
    try {
      const response = await fetch(this.EXTERNAL_API_URL);
      if (!response.ok) {
        throw new Error(
          `Error en la API externa: ${response.status} ${response.statusText}`,
        );
      }

      const payload = await response.json();

      // buy = Precio al que compran USD con BOB (ej: 9.32 BOB por USD)
      const buyRateBobPerUsd = payload?.buy?.data?.result?.exchangeRate;
      // sell = Precio al que venden USD por BOB (ej: 9.28 BOB por USD)
      const sellRateBobPerUsd = payload?.sell?.data?.result?.exchangeRate;

      if (!buyRateBobPerUsd || !sellRateBobPerUsd) {
        throw new Error(
          'Payload inválido desde el API externo (exchange rates faltantes).',
        );
      }

      // 1. Tasa de compra: cuántos BOB por 1 USD (directo del API)
      const bobToUsdRate = buyRateBobPerUsd;

      // 2. De USD a BOB (User da USD, recibe BOB)
      const usdToBobRate = sellRateBobPerUsd;

      // Actualizamos los 2 pares canónicos en la base de datos
      await this.updateRateInternal('BOB_USD', bobToUsdRate, actorId);
      await this.updateRateInternal('USD_BOB', usdToBobRate, actorId);

      this.logger.log(
        'Sincronización de tasas de cambio completada exitosamente.',
      );

      // Los cruzados se sincronizan en su propio bloque para que un fallo de Bridge
      // no enmascare el éxito del par ancla BOB/USD que ya quedó guardado.
      try {
        await this.syncBridgeCrossRates(actorId);
      } catch (crossErr) {
        this.logger.warn(
          `Tasas BOB/USD actualizadas, pero falló la sincronización de cruzados: ${(crossErr as Error).message}`,
        );
      }

      return {
        message: 'Tasas sincronizadas correctamente',
        buy_rate_bob_usd: bobToUsdRate,
        sell_rate_usd_bob: usdToBobRate,
      };
    } catch (error) {
      this.logger.error(
        `Falló la sincronización de tasas de cambio: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        'No se pudo establecer conexión con el proveedor de tipos de cambio.',
      );
    }
  }

  /**
   * Sincroniza los 10 pares cruzados BOB/X y X/BOB usando buy_rate y sell_rate
   * de Bridge (5 llamadas HTTP, una por divisa).
   *
   * BOB_X = BOB_USD_base / buy_rate(USD→X)   — usuario compra X con BOB
   * X_BOB = USD_BOB_base / sell_rate(USD→X)  — usuario vende X para obtener BOB
   *
   * Los valores crudos de Bridge (buy_rate, sell_rate) se guardan en la DB
   * para trazabilidad. Si Bridge falla en una divisa concreta se loguea y continúa.
   */
  async syncBridgeCrossRates(actorId = 'system_cron') {
    const [bobUsdData, usdBobData] = await Promise.all([
      this.getRate('BOB_USD'),
      this.getRate('USD_BOB'),
    ]);
    const bobUsdBase = bobUsdData.base_rate;
    const usdBobBase = usdBobData.base_rate;

    for (const currency of this.BRIDGE_CURRENCIES) {
      try {
        const resp = await this.bridgeApi.get<BridgeExchangeRateResponse>(
          `/v0/exchange_rates?from=usd&to=${currency}`,
        );
        const buyRate  = parseFloat(resp.buy_rate);
        const sellRate = parseFloat(resp.sell_rate);

        if (!buyRate || buyRate <= 0 || !sellRate || sellRate <= 0) {
          this.logger.warn(
            `Bridge devolvió rates inválidos para USD→${currency}: buy=${resp.buy_rate} sell=${resp.sell_rate}`,
          );
          continue;
        }

        const upper = currency.toUpperCase();
        // COP necesita más precisión: su rate es muy pequeño (~0.0029) y al
        // redondear el base_rate a 4 decimales se perdía la diferencia entre
        // BOB_COP y COP_BOB. Para el resto de divisas se mantiene en 4.
        const roundingFactor = currency === 'cop' ? 1_000_000 : 10000;
        // BOB_X: usuario da BOB, recibe X → Bridge vende X a Guira → sell_rate (igual que USD_X)
        const bobXRate = Math.round((bobUsdBase / sellRate) * roundingFactor) / roundingFactor;
        // X_BOB: usuario da X, recibe BOB → Bridge compra X de Guira → buy_rate
        const xBobRate = Math.round((usdBobBase / buyRate) * roundingFactor) / roundingFactor;

        const bridgeRates = { buy_rate: buyRate, sell_rate: sellRate };
        await this.updateRateInternal(`BOB_${upper}`, bobXRate, actorId, bridgeRates);
        await this.updateRateInternal(`${upper}_BOB`, xBobRate, actorId, bridgeRates);
        // USD_X: cliente da USDC (≈USD), recibe X → Bridge vende X → sell_rate
        await this.updateRateInternal(`USD_${upper}`, sellRate, actorId, bridgeRates);
      } catch (e) {
        this.logger.warn(
          `No se pudo sincronizar par BOB/${currency.toUpperCase()} desde Bridge: ${(e as Error).message}`,
        );
      }
    }

    this.logger.log('Sincronización de tasas cruzadas Bridge completada.');
  }

  /**
   * Método interno helper para updates estandarizados sin parámetros de spread.
   * bridgeRates solo se pasa para pares cruzados (EUR, BRL, etc.); es null para BOB_USD/USD_BOB.
   */
  private async updateRateInternal(
    pair: string,
    rate: number,
    actorId: string,
    bridgeRates?: { buy_rate: number; sell_rate: number },
  ) {
    try {
      const old = await this.getRate(pair);

      const updatePayload: Record<string, unknown> = {
        rate,
        updated_by: actorId.startsWith('system') ? null : actorId,
        updated_at: new Date().toISOString(),
      };

      if (bridgeRates) {
        updatePayload.bridge_buy_rate  = bridgeRates.buy_rate;
        updatePayload.bridge_sell_rate = bridgeRates.sell_rate;
      }

      await this.supabase
        .from('exchange_rates_config')
        .update(updatePayload)
        .eq('pair', pair.toUpperCase());

      // Emitir con datos locales — sin consulta extra que pueda fallar tras el UPDATE
      this.gateway.emitRateUpdated(
        this.buildRateUpdatedPayload(
          pair,
          rate,
          old.spread_percent,
          bridgeRates?.buy_rate ?? old.bridge_buy_rate ?? null,
          bridgeRates?.sell_rate ?? old.bridge_sell_rate ?? null,
        ),
      );

      // Los syncs automáticos (system_cron) no se escriben en audit_logs —
      // generaban ~37k filas de ruido. El historial de cada par vive en
      // exchange_rates_config.updated_at + updated_by.
      // Solo se audita cuando el cambio lo inicia un operador humano.
      if (!actorId.includes('system')) {
        await this.supabase.from('audit_logs').insert({
          performed_by: actorId,
          action: 'UPDATE_EXCHANGE_RATE',
          table_name: 'exchange_rates_config',
          previous_values: { rate: old.base_rate },
          new_values: { rate, pair },
          source: 'admin_panel',
        });
      }
    } catch (e) {
      this.logger.warn(
        `El par ${pair} no está inicializado en la base de datos o hubo un error: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Obtiene el tipo de cambio para un par, aplicando el spread.
   *
   * El spread se aplica SIEMPRE en contra del usuario (a favor de la plataforma):
   *   - Para compra (BOB → USD): el usuario recibe menos USD
   *   - Para venta (USD → BOB): el usuario recibe menos BOB
   */
  async getRate(pair: string) {
    const resolvedPair =
      this.PAIR_ALIASES[pair.toUpperCase()] ?? pair.toUpperCase();

    const { data, error } = await this.supabase
      .from('exchange_rates_config')
      .select('*')
      .eq('pair', resolvedPair)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Tipo de cambio no configurado para ${pair}`);
    }

    const baseRate = parseFloat(data.rate);
    const spreadPercent = parseFloat(data.spread_percent ?? '0');
    const bridgeBuyRate =
      data.bridge_buy_rate != null ? parseFloat(data.bridge_buy_rate) : null;
    const bridgeSellRate =
      data.bridge_sell_rate != null ? parseFloat(data.bridge_sell_rate) : null;

    // El spread se aplica SIEMPRE en contra del usuario:
    // - Para BOB_USD (dividimos): SUBIR la tasa → el divisor es mayor → usuario recibe MENOS USD
    // - Para USD_BOB (multiplicamos): BAJAR la tasa → el multiplicador es menor → usuario recibe MENOS BOB
    const isBobPair = data.pair.toUpperCase().startsWith('BOB_');
    const spreadMultiplier = isBobPair
      ? 1 + spreadPercent / 100 // subir tasa para penalizar al dividir
      : 1 - spreadPercent / 100; // bajar tasa para penalizar al multiplicar
    const effectiveRate = this.roundEffectiveRate(baseRate * spreadMultiplier, data.pair);

    return {
      pair: data.pair,
      base_rate: baseRate,
      spread_percent: spreadPercent,
      effective_rate: effectiveRate,
      bridge_buy_rate: bridgeBuyRate,
      bridge_sell_rate: bridgeSellRate,
      updated_at: data.updated_at,
    };
  }

  /** Convierte un monto aplicando tipo de cambio con spread. */
  async convertAmount(
    amount: number,
    fromCurrency: string,
    toCurrency: string,
  ) {
    const pair = `${fromCurrency}_${toCurrency}`.toUpperCase();
    const rateData = await this.getRate(pair);

    // Ahora todas las tasas almacenan "BOB por 1 USD"
    // BOB→USD/USDC: dividir (cuántos USD obtienes por X BOB)
    // USD/USDC→BOB: multiplicar (cuántos BOB obtienes por X USD)
    if (!rateData.effective_rate) {
      throw new BadRequestException(
        `Tipo de cambio ${pair} no tiene tasa efectiva válida. Verifique la configuración.`,
      );
    }

    const isBobToUsd = pair.startsWith('BOB_');
    const converted = isBobToUsd
      ? amount / rateData.effective_rate
      : amount * rateData.effective_rate;

    return {
      original_amount: amount,
      original_currency: fromCurrency.toUpperCase(),
      converted_amount: parseFloat(converted.toFixed(2)),
      destination_currency: toCurrency.toUpperCase(),
      rate_applied: rateData.effective_rate,
      base_rate: rateData.base_rate,
      spread_percent: rateData.spread_percent,
    };
  }

  async getAllRates() {
    const { data, error } = await this.supabase
      .from('exchange_rates_config')
      .select('*')
      .order('pair');

    if (error) throwDbError(error);

    return (data ?? []).map((row) => {
      const baseRate = parseFloat(row.rate);
      const spreadPercent = parseFloat(row.spread_percent ?? '0');
      const isBobPair = row.pair.toUpperCase().startsWith('BOB_');

      const spreadMultiplier = isBobPair
        ? 1 + spreadPercent / 100
        : 1 - spreadPercent / 100;

      const effectiveRate = this.roundEffectiveRate(baseRate * spreadMultiplier, row.pair);

      return {
        ...row,
        base_rate: baseRate,
        spread_percent: spreadPercent,
        effective_rate: effectiveRate,
      };
    });
  }

  /** Actualiza tipo de cambio (solo admin, manual). */
  async updateRate(
    pair: string,
    dto: { rate: number; spread_percent?: number },
    actorId: string,
  ) {
    const resolvedPair =
      this.PAIR_ALIASES[pair.toUpperCase()] ?? pair.toUpperCase();

    // Obtener valores previos para audit
    const old = await this.getRate(resolvedPair);

    const updatePayload: Record<string, unknown> = {
      rate: dto.rate,
      updated_by: actorId,
      updated_at: new Date().toISOString(),
    };

    if (dto.spread_percent !== undefined) {
      updatePayload.spread_percent = dto.spread_percent;
    }

    const { data, error } = await this.supabase
      .from('exchange_rates_config')
      .update(updatePayload)
      .eq('pair', resolvedPair)
      .select()
      .single();

    if (error) throwDbError(error);

    // Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      action: 'UPDATE_EXCHANGE_RATE',
      table_name: 'exchange_rates_config',
      previous_values: {
        rate: old.base_rate,
        spread: old.spread_percent,
      },
      new_values: {
        rate: dto.rate,
        spread: dto.spread_percent ?? old.spread_percent,
        pair,
      },
      source: 'admin_panel',
    });

    this.logger.log(
      `✅ Exchange rate ${pair} actualizado por ${actorId}: ${old.base_rate} → ${dto.rate}`,
    );

    // Emitir con datos locales — sin consulta extra que pueda fallar tras el UPDATE
    const spread = dto.spread_percent ?? old.spread_percent;
    this.gateway.emitRateUpdated(
      this.buildRateUpdatedPayload(
        resolvedPair,
        dto.rate,
        spread,
        old.bridge_buy_rate,
        old.bridge_sell_rate,
      ),
    );

    // Si se actualizó un par ancla BOB/USD, recalcular los cruzados desde Bridge
    if (resolvedPair === 'BOB_USD' || resolvedPair === 'USD_BOB') {
      this.syncBridgeCrossRates(actorId).catch((e) =>
        this.logger.warn(`No se pudo sincronizar cruzados tras actualización manual: ${(e as Error).message}`),
      );
    }

    return data;
  }
}

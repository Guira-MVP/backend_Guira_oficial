import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExchangeRatesGateway } from './exchange-rates.gateway';
import type { RateUpdatedPayload } from './exchange-rates.gateway';

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

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gateway: ExchangeRatesGateway,
  ) {}

  /** Construye el payload para la notificación WS sin consultar DB nuevamente. */
  private buildRateUpdatedPayload(
    pair: string,
    baseRate: number,
    spreadPercent: number,
  ): RateUpdatedPayload {
    const isBobPair = pair.toUpperCase().startsWith('BOB_');
    const spreadMultiplier = isBobPair
      ? 1 + spreadPercent / 100
      : 1 - spreadPercent / 100;
    const effectiveRate =
      Math.round(baseRate * spreadMultiplier * 100) / 100;

    return {
      pair,
      base_rate: baseRate,
      spread_percent: spreadPercent,
      effective_rate: effectiveRate,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Tarea automática para sincronizar las tasas de cambio diariamente (a medianoche).
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
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
   * Método interno helper para updates estandarizados sin parámetros de spread
   */
  private async updateRateInternal(
    pair: string,
    rate: number,
    actorId: string,
  ) {
    try {
      const old = await this.getRate(pair);

      await this.supabase
        .from('exchange_rates_config')
        .update({
          rate,
          updated_by: actorId,
          updated_at: new Date().toISOString(),
        })
        .eq('pair', pair.toUpperCase());

      // Emitir con datos locales — sin consulta extra que pueda fallar tras el UPDATE
      this.gateway.emitRateUpdated(
        this.buildRateUpdatedPayload(pair, rate, old.spread_percent),
      );

      await this.supabase.from('audit_logs').insert({
        performed_by: actorId === 'system_cron' ? null : actorId,
        action: 'DB_SYNC_EXCHANGE_RATE',
        table_name: 'exchange_rates_config',
        previous_values: { rate: old.base_rate },
        new_values: { rate: rate, pair },
        source: actorId.includes('system') ? 'system' : 'admin_panel',
      });
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

    // El spread se aplica SIEMPRE en contra del usuario:
    // - Para BOB_USD (dividimos): SUBIR la tasa → el divisor es mayor → usuario recibe MENOS USD
    // - Para USD_BOB (multiplicamos): BAJAR la tasa → el multiplicador es menor → usuario recibe MENOS BOB
    const isBobPair = data.pair.toUpperCase().startsWith('BOB_');
    const spreadMultiplier = isBobPair
      ? 1 + spreadPercent / 100 // subir tasa para penalizar al dividir
      : 1 - spreadPercent / 100; // bajar tasa para penalizar al multiplicar
    const effectiveRate = Math.round(baseRate * spreadMultiplier * 100) / 100;

    return {
      pair: data.pair,
      base_rate: baseRate,
      spread_percent: spreadPercent,
      effective_rate: effectiveRate,
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

    if (error) throw new BadRequestException(error.message);

    return (data ?? []).map((row) => {
      const baseRate = parseFloat(row.rate);
      const spreadPercent = parseFloat(row.spread_percent ?? '0');
      const isBobPair = row.pair.toUpperCase().startsWith('BOB_');

      const spreadMultiplier = isBobPair
        ? 1 + spreadPercent / 100
        : 1 - spreadPercent / 100;

      const effectiveRate = Math.round(baseRate * spreadMultiplier * 100) / 100;

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

    if (error) throw new BadRequestException(error.message);

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
      this.buildRateUpdatedPayload(resolvedPair, dto.rate, spread),
    );

    return data;
  }
}

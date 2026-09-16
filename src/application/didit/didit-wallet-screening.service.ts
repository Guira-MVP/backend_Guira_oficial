import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { DiditApiClient } from './didit-api.client';
import {
  DIDIT_WALLET_SCREENING_NETWORKS,
  WALLET_SCREENING_ENABLED_SETTING_KEY,
} from './didit.constants';
import {
  DiditWalletScreeningRaw,
  WalletScreeningVerdict,
} from './didit.types';

/**
 * Screening AML de la dirección cripto de un beneficiario, en el momento en
 * que el cliente la registra.
 *
 * Capa aditiva: este servicio NUNCA lanza. Devuelve siempre un veredicto con
 * la decisión ya calculada (`allow` / `flag` / `block`) para que
 * SuppliersService no tenga que interpretar bandas de riesgo por su cuenta.
 * Si Didit falla, está apagado o la red no tiene cobertura, la decisión es
 * `allow` y el beneficiario se crea igual — un problema del proveedor no
 * puede dejar al cliente sin poder registrar beneficiarios.
 *
 * El único caso que bloquea es el que pidió negocio: sanciones o riesgo
 * crítico.
 */
@Injectable()
export class DiditWalletScreeningService {
  private readonly logger = new Logger(DiditWalletScreeningService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly diditApi: DiditApiClient,
  ) {}

  /**
   * Lee el interruptor de `app_settings`.
   *
   * Por defecto DESHABILITADO: si la fila no existe o la consulta falla, no se
   * llama a Didit. Cada screening es facturable y requiere un proveedor de
   * monitoreo configurado en la consola, así que el fallo seguro es no llamar.
   */
  private async isEnabled(): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('app_settings')
      .select('value')
      .eq('key', WALLET_SCREENING_ENABLED_SETTING_KEY)
      .maybeSingle();

    if (error) {
      this.logger.warn(
        `No se pudo leer ${WALLET_SCREENING_ENABLED_SETTING_KEY} de app_settings (${error.message}) — screening omitido.`,
      );
      return false;
    }

    return String(data?.value ?? '').trim().toLowerCase() === 'true';
  }

  private skipped(reason: string): WalletScreeningVerdict {
    return {
      schema_version: 1,
      status: 'Skipped',
      decision: 'allow',
      screened_at: new Date().toISOString(),
      skip_reason: reason,
    };
  }

  /**
   * Traduce la respuesta de Didit a un veredicto accionable.
   *
   * Se conserva `risk_score` además de `severity` porque `UNKNOWN` es la banda
   * más baja (0-9), no un "sin datos": un score de 1-9 es una señal real y no
   * debe presentarse como aprobado sin matices.
   */
  private mapVerdict(raw: DiditWalletScreeningRaw): WalletScreeningVerdict {
    const base = {
      schema_version: 1 as const,
      screened_at: new Date().toISOString(),
      provider: raw.provider,
      blockchain: raw.blockchain,
      risk_score: raw.risk_score,
      severity: raw.severity,
      sanctions_hit: raw.sanctions_hit,
      dominant_risk_category: raw.dominant_risk_category ?? null,
      summary: raw.summary,
      // `risk_factors` es opcional en la respuesta: los resultados anteriores a
      // su existencia omiten la clave, y hay que leerla como lista vacía.
      risk_factors: raw.risk_factors ?? [],
    };

    // El proveedor no pudo resolver. No hay veredicto que aplicar, así que no
    // se bloquea ni se avisa al cliente; queda registrado para el staff.
    if (raw.status === 'ERROR') {
      return { ...base, status: 'Error', decision: 'allow' };
    }
    if (raw.status === 'PENDING') {
      return { ...base, status: 'In Review', decision: 'allow' };
    }

    if (raw.sanctions_hit === true || raw.severity === 'CRITICAL') {
      return { ...base, status: 'Declined', decision: 'block' };
    }

    if (raw.severity === 'HIGH' || raw.severity === 'MEDIUM') {
      return { ...base, status: 'In Review', decision: 'flag' };
    }

    return { ...base, status: 'Approved', decision: 'allow' };
  }

  /**
   * Screenea la wallet de un beneficiario cripto que se está creando.
   * Nunca lanza: ver la nota de la clase.
   */
  async screenBeneficiaryWallet(input: {
    walletAddress: string;
    walletNetwork: string;
    userId: string;
  }): Promise<WalletScreeningVerdict> {
    if (!(await this.isEnabled())) {
      return this.skipped('Revisión de wallets deshabilitada en configuración');
    }

    if (!this.diditApi.isConfigured) {
      this.logger.warn(
        'WALLET_SCREENING_ENABLED está activo pero DIDIT_API_KEY no está configurada — screening omitido.',
      );
      return this.skipped('Didit no configurado');
    }

    const network = input.walletNetwork.trim().toLowerCase();
    const blockchain = DIDIT_WALLET_SCREENING_NETWORKS[network];

    if (!blockchain) {
      // Enviar una red no soportada daría 400. Se omite explícitamente y queda
      // el motivo guardado, igual que con los países sin Database Validation.
      return this.skipped(`La red ${network} no tiene cobertura de screening en Didit`);
    }

    try {
      const raw = await this.diditApi.screenWallet({
        walletAddress: input.walletAddress,
        blockchain,
      });

      const verdict = this.mapVerdict(raw);

      this.logger.log(
        `Wallet screening (${network}) para usuario ${input.userId}: ` +
          `${verdict.status} / ${verdict.decision} (score=${verdict.risk_score ?? 'n/a'}, ` +
          `severity=${verdict.severity ?? 'n/a'}, sanciones=${verdict.sanctions_hit ?? false})`,
      );

      return verdict;
    } catch (err) {
      // La dirección NO se loguea: es un dato del beneficiario y el logger no
      // es el sitio para dejarlo.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Wallet screening falló para usuario ${input.userId} en red ${network}: ${message}`,
      );

      return {
        schema_version: 1,
        status: 'Error',
        decision: 'allow',
        screened_at: new Date().toISOString(),
        blockchain,
        error_message: message,
      };
    }
  }
}

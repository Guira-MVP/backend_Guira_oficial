import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';

export const TAZAPAY_SWIFT_ENABLED_SETTING_KEY =
  'TAZAPAY_SWIFT_BENEFICIARIES_ENABLED';
export const TAZAPAY_SWIFT_ALLOWED_CURRENCIES_SETTING_KEY =
  'TAZAPAY_SWIFT_ALLOWED_CURRENCIES';

export type SwiftIneligibilityReason =
  | 'FEATURE_DISABLED'
  | 'NOT_KYB'
  | 'ENTITY_MISSING'
  | 'ENTITY_PENDING'
  | 'ENTITY_REQUIRES_ACTION'
  | 'ENTITY_REJECTED';

export interface SwiftEligibility {
  eligible: boolean;
  reason: SwiftIneligibilityReason | null;
  message: string | null;
  entityId: string | null;
}

const MESSAGES: Record<SwiftIneligibilityReason, string> = {
  FEATURE_DISABLED:
    'Las transferencias internacionales SWIFT todavía no están disponibles.',
  NOT_KYB:
    'Las transferencias internacionales SWIFT están disponibles solo para cuentas de empresa.',
  ENTITY_MISSING:
    'Tu cuenta aún no está habilitada para transferencias SWIFT. Nuestro equipo te avisará cuando lo esté.',
  ENTITY_PENDING:
    'Tu cuenta está en revisión para habilitar transferencias SWIFT. Te avisaremos cuando esté lista.',
  ENTITY_REQUIRES_ACTION:
    'Para habilitar transferencias SWIFT necesitamos información adicional. Nuestro equipo se pondrá en contacto contigo.',
  ENTITY_REJECTED:
    'Tu cuenta no fue habilitada para transferencias SWIFT. Contacta con soporte si necesitas más información.',
};

/**
 * Decide si un cliente puede registrar beneficiarios SWIFT (Tazapay).
 *
 * Reglas (decididas el 2026-10-05):
 *  - el interruptor TAZAPAY_SWIFT_BENEFICIARIES_ENABLED está activo;
 *  - el cliente tiene entity en Tazapay APROBADA (provider_accounts);
 *  - esa entity viene de un KYB: el wire USD de Tazapay solo admite remitente
 *    empresa (B2B/B2C), así que en esta etapa SWIFT es solo para empresas.
 */
@Injectable()
export class TazapaySwiftEligibilityService {
  private readonly logger = new Logger(TazapaySwiftEligibilityService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  async isFeatureEnabled(): Promise<boolean> {
    const value = await this.readSetting(TAZAPAY_SWIFT_ENABLED_SETTING_KEY);
    return value.trim().toLowerCase() === 'true';
  }

  /** Monedas permitidas por configuración; lista vacía = todas. */
  async getAllowedCurrencies(): Promise<string[]> {
    const value = await this.readSetting(
      TAZAPAY_SWIFT_ALLOWED_CURRENCIES_SETTING_KEY,
    );
    return value
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter((c) => /^[A-Z]{3}$/.test(c));
  }

  async check(userId: string): Promise<SwiftEligibility> {
    if (!(await this.isFeatureEnabled())) {
      return this.result('FEATURE_DISABLED');
    }

    const { data: account, error } = await this.supabase
      .from('provider_accounts')
      .select('external_id, status')
      .eq('user_id', userId)
      .eq('provider', 'tazapay')
      .maybeSingle();

    if (error) {
      this.logger.warn(
        `No se pudo leer provider_accounts de ${userId}: ${error.message}`,
      );
      return this.result('ENTITY_MISSING');
    }
    if (!account?.external_id) return this.result('ENTITY_MISSING');

    // La entity tiene que venir de un expediente KYB. Se busca la submission
    // que la creó, no profiles.account_type (que es declarativo).
    const { data: kybSubmission } = await this.supabase
      .from('provider_onboarding_submissions')
      .select('id')
      .eq('user_id', userId)
      .eq('provider', 'tazapay')
      .eq('external_id', account.external_id)
      .not('kyb_application_id', 'is', null)
      .limit(1)
      .maybeSingle();
    if (!kybSubmission) return this.result('NOT_KYB');

    switch (account.status) {
      case 'approved':
        return {
          eligible: true,
          reason: null,
          message: null,
          entityId: account.external_id as string,
        };
      case 'requires_action':
        return this.result('ENTITY_REQUIRES_ACTION');
      case 'rejected':
      case 'disabled':
        return this.result('ENTITY_REJECTED');
      default:
        return this.result('ENTITY_PENDING');
    }
  }

  /** Igual que check() pero lanza 403 con el motivo si no es elegible. */
  async assertEligible(userId: string): Promise<string> {
    const result = await this.check(userId);
    if (!result.eligible || !result.entityId) {
      throw new ForbiddenException({
        code: result.reason ?? 'ENTITY_MISSING',
        message: result.message ?? MESSAGES.ENTITY_MISSING,
      });
    }
    return result.entityId;
  }

  private result(reason: SwiftIneligibilityReason): SwiftEligibility {
    return {
      eligible: false,
      reason,
      message: MESSAGES[reason],
      entityId: null,
    };
  }

  private async readSetting(key: string): Promise<string> {
    const { data, error } = await this.supabase
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) {
      this.logger.warn(`No se pudo leer ${key}: ${error.message}`);
      return '';
    }
    return String(data?.value ?? '');
  }
}

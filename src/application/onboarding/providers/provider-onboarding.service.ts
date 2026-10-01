import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';
import { TazapayApiError } from '../../tazapay/tazapay-api.client';
import { TazapayMappingError } from '../../tazapay/onboarding/tazapay-business-mapper';
import { TazapayKybOnboardingService } from '../../tazapay/onboarding/tazapay-kyb-onboarding.service';

export const TAZAPAY_ONBOARDING_ENABLED_SETTING_KEY =
  'TAZAPAY_ONBOARDING_ENABLED';
const MAX_ATTEMPTS = 5;
const STALE_SUBMITTED_HOURS = 24;

type Provider = 'bridge' | 'tazapay';
type SubjectType = 'kyc_applications' | 'kyb_applications';

/** approval_status de Tazapay (entity) → estado normalizado de Guira. */
const TAZAPAY_STATUS_MAP: Record<string, string> = {
  initiated: 'draft',
  in_draft: 'draft',
  submitted: 'submitted',
  processing: 'submitted',
  pending: 'requires_action',
  requires_action: 'requires_action',
  resubmitted: 'submitted',
  approved: 'approved',
  succeeded: 'approved',
  rejected: 'rejected',
};

/** Estado de la submission → estado de la cuenta del cliente en el proveedor. */
const ACCOUNT_STATUS: Record<string, string> = {
  draft: 'pending',
  submitted: 'submitted',
  requires_action: 'requires_action',
  approved: 'approved',
  rejected: 'rejected',
};

/**
 * Orquesta el alta del cliente en cada proveedor al aprobar el staff un
 * KYC/KYB. Bridge sigue su flujo de siempre (ComplianceActionsService.
 * sendToBridgeSubject); aquí solo se registra su envío. Tazapay se despacha
 * aparte y NUNCA hace fallar la aprobación: si no es elegible o falla, queda
 * registrado en provider_onboarding_submissions y Bridge sigue igual
 * (la aprobación es por proveedor).
 */
@Injectable()
export class ProviderOnboardingService {
  private readonly logger = new Logger(ProviderOnboardingService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly tazapayKyb: TazapayKybOnboardingService,
  ) {}

  // ── Interruptor ────────────────────────────────────────────────────────

  async isTazapayEnabled(): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('app_settings')
      .select('value')
      .eq('key', TAZAPAY_ONBOARDING_ENABLED_SETTING_KEY)
      .maybeSingle();
    if (error) {
      this.logger.warn(
        `No se pudo leer ${TAZAPAY_ONBOARDING_ENABLED_SETTING_KEY}: ${error.message}`,
      );
      return false;
    }
    return (
      String(data?.value ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  // ── Al aprobar el staff ────────────────────────────────────────────────

  /**
   * Llamado después de que Bridge aceptó el expediente. Registra el envío a
   * Bridge y, si el interruptor está activo, encola el de Tazapay.
   */
  async afterStaffApproval(
    subjectType: string,
    subjectId: string,
  ): Promise<void> {
    if (
      subjectType !== 'kyc_applications' &&
      subjectType !== 'kyb_applications'
    )
      return;
    try {
      const userId = await this.resolveUserId(subjectType, subjectId);
      if (!userId) return;
      await this.recordBridgeSubmission(subjectType, subjectId, userId);

      if (!(await this.isTazapayEnabled())) return;
      if (subjectType !== 'kyb_applications') {
        // El KYC de personas en Tazapay es la fase siguiente del plan.
        this.logger.log(
          `KYC ${subjectId}: envío a Tazapay aún no implementado para personas.`,
        );
        return;
      }
      const submissionId = await this.ensureSubmission(
        'tazapay',
        subjectType,
        subjectId,
        userId,
      );
      void this.processTazapaySubmission(submissionId);
    } catch (err) {
      this.logger.error(
        `afterStaffApproval(${subjectType}, ${subjectId}): ${(err as Error).message}`,
      );
    }
  }

  private async resolveUserId(
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<string | null> {
    if (subjectType === 'kyc_applications') {
      const { data } = await this.supabase
        .from('kyc_applications')
        .select('user_id')
        .eq('id', subjectId)
        .maybeSingle();
      return (data?.user_id as string) ?? null;
    }
    const { data } = await this.supabase
      .from('kyb_applications')
      .select('requester_user_id')
      .eq('id', subjectId)
      .maybeSingle();
    return (data?.requester_user_id as string) ?? null;
  }

  private applicationColumn(subjectType: SubjectType) {
    return subjectType === 'kyc_applications'
      ? 'kyc_application_id'
      : 'kyb_application_id';
  }

  private async ensureSubmission(
    provider: Provider,
    subjectType: SubjectType,
    subjectId: string,
    userId: string,
    initial: Record<string, unknown> = {},
  ): Promise<string> {
    const column = this.applicationColumn(subjectType);
    const { data: existing } = await this.supabase
      .from('provider_onboarding_submissions')
      .select('id')
      .eq(column, subjectId)
      .eq('provider', provider)
      .maybeSingle();
    if (existing?.id) return existing.id as string;

    const { data, error } = await this.supabase
      .from('provider_onboarding_submissions')
      .insert({
        user_id: userId,
        provider,
        [column]: subjectId,
        idempotency_key: `${provider}:${subjectId}`,
        ...initial,
      })
      .select('id')
      .single();
    if (error || !data) {
      // Carrera con otra aprobación: releer.
      const { data: again } = await this.supabase
        .from('provider_onboarding_submissions')
        .select('id')
        .eq(column, subjectId)
        .eq('provider', provider)
        .maybeSingle();
      if (again?.id) return again.id as string;
      throw new Error(
        `No se pudo crear la submission ${provider}: ${error?.message}`,
      );
    }
    return data.id as string;
  }

  private async recordBridgeSubmission(
    subjectType: SubjectType,
    subjectId: string,
    userId: string,
  ) {
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id')
      .eq('id', userId)
      .maybeSingle();
    const customerId = (profile?.bridge_customer_id as string) ?? null;
    const id = await this.ensureSubmission(
      'bridge',
      subjectType,
      subjectId,
      userId,
      { status: 'submitted' },
    );
    await this.supabase
      .from('provider_onboarding_submissions')
      .update({
        status: 'submitted',
        external_id: customerId,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    await this.upsertAccount(userId, 'bridge', {
      external_id: customerId,
      status: 'submitted',
    });
  }

  private async upsertAccount(
    userId: string,
    provider: Provider,
    values: Record<string, unknown>,
  ) {
    await this.supabase.from('provider_accounts').upsert(
      {
        user_id: userId,
        provider,
        ...values,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,provider' },
    );
  }

  // ── Resultado de Bridge (webhook) ──────────────────────────────────────

  async markBridgeOutcome(
    userId: string,
    outcome: 'approved' | 'rejected',
    reason?: string,
  ): Promise<void> {
    try {
      const now = new Date().toISOString();
      await this.upsertAccount(userId, 'bridge', {
        status: outcome,
        ...(outcome === 'approved'
          ? { approved_at: now }
          : { rejected_at: now, status_reason: reason ?? null }),
      });
      await this.supabase
        .from('provider_onboarding_submissions')
        .update({ status: outcome, updated_at: now })
        .eq('user_id', userId)
        .eq('provider', 'bridge')
        .in('status', ['submitted', 'requires_action']);
    } catch (err) {
      this.logger.warn(
        `markBridgeOutcome(${userId}): ${(err as Error).message}`,
      );
    }
  }

  // ── Procesamiento de Tazapay ───────────────────────────────────────────

  /**
   * Toma la submission (si nadie más la está procesando) y la lleva hasta
   * `submitted`, `not_eligible`, `pending_provider_confirmation`, `pending`
   * (falta algo del staff) o `failed_*`.
   */
  async processTazapaySubmission(submissionId: string): Promise<void> {
    const now = new Date().toISOString();
    const { data: claimed } = await this.supabase
      .from('provider_onboarding_submissions')
      .update({ status: 'creating', updated_at: now })
      .eq('id', submissionId)
      .eq('provider', 'tazapay')
      .in('status', [
        'pending',
        'failed_retryable',
        'draft',
        'uploading_documents',
      ])
      .select(
        'id, user_id, kyb_application_id, kyc_application_id, external_id, idempotency_key, attempt_count',
      )
      .maybeSingle();
    if (!claimed) return; // otro proceso la tomó o ya terminó

    if (!claimed.kyb_application_id) {
      await this.finish(submissionId, {
        status: 'pending',
        ineligibility_reason:
          'KYC de personas: envío a Tazapay aún no implementado.',
      });
      return;
    }

    try {
      if (!this.tazapayKyb.isConfigured) {
        throw new TazapayApiError(
          'Tazapay no está configurado (faltan TAZAPAY_API_KEY / TAZAPAY_API_SECRET).',
          null,
          false,
          null,
        );
      }

      const ctx = await this.tazapayKyb.loadContext(
        claimed.kyb_application_id as string,
      );
      const eligibility = await this.tazapayKyb.checkEligibility(ctx.business);
      if (eligibility.status !== 'eligible') {
        await this.finish(submissionId, {
          status: eligibility.status,
          ineligibility_reason: eligibility.reason,
        });
        await this.upsertAccount(ctx.userId, 'tazapay', {
          status: 'pending',
          status_reason: eligibility.reason,
        });
        return;
      }

      const result = await this.tazapayKyb.run({
        id: claimed.id as string,
        user_id: claimed.user_id as string,
        kyb_application_id: claimed.kyb_application_id as string,
        external_id: (claimed.external_id as string) ?? null,
        idempotency_key: claimed.idempotency_key as string,
        attempt_count: (claimed.attempt_count as number) ?? 0,
      });

      const normalized =
        TAZAPAY_STATUS_MAP[String(result.rawStatus ?? 'submitted')] ??
        'submitted';
      await this.finish(submissionId, {
        status: normalized,
        raw_status: result.rawStatus,
        external_id: result.entityId,
        request_payload: result.requestSnapshot,
        ineligibility_reason: null,
        last_error_code: null,
        last_error_message: null,
        submitted_at: new Date().toISOString(),
      });
      await this.upsertAccount(ctx.userId, 'tazapay', {
        external_id: result.entityId,
        status: ACCOUNT_STATUS[normalized] ?? 'submitted',
        raw_status: result.rawStatus,
        status_reason: null,
      });
    } catch (err) {
      const attempts = ((claimed.attempt_count as number) ?? 0) + 1;
      const isMapping = err instanceof TazapayMappingError;
      const retryable =
        !isMapping && (err instanceof TazapayApiError ? err.retryable : true);
      const status = isMapping
        ? 'pending'
        : retryable && attempts < MAX_ATTEMPTS
          ? 'failed_retryable'
          : 'failed_terminal';
      const message =
        err instanceof TazapayApiError && err.providerMessage
          ? `${err.message} — ${err.providerMessage}`
          : (err as Error).message;
      this.logger.warn(
        `Tazapay submission ${submissionId} → ${status}: ${message}`,
      );
      await this.finish(submissionId, {
        status,
        attempt_count: isMapping
          ? ((claimed.attempt_count as number) ?? 0)
          : attempts,
        ...(isMapping
          ? { ineligibility_reason: message }
          : {
              last_error_code:
                err instanceof TazapayApiError
                  ? String(err.status ?? 'network')
                  : 'error',
              last_error_message: message.slice(0, 2000),
            }),
      });
    }
  }

  private async finish(submissionId: string, values: Record<string, unknown>) {
    await this.supabase
      .from('provider_onboarding_submissions')
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq('id', submissionId);
  }

  /** Reintento manual del staff. Vuelve a evaluar elegibilidad y datos. */
  async retryTazapay(submissionId: string): Promise<{ status: string }> {
    const { data: sub } = await this.supabase
      .from('provider_onboarding_submissions')
      .select('id, provider, status')
      .eq('id', submissionId)
      .maybeSingle();
    if (!sub || sub.provider !== 'tazapay')
      throw new NotFoundException('Envío a Tazapay no encontrado');
    if (
      [
        'submitted',
        'requires_action',
        'approved',
        'rejected',
        'creating',
      ].includes(sub.status as string)
    ) {
      throw new BadRequestException(
        `El envío está en estado ${String(sub.status)}: no se puede reintentar.`,
      );
    }
    await this.finish(submissionId, { status: 'pending' });
    await this.processTazapaySubmission(submissionId);
    const { data: after } = await this.supabase
      .from('provider_onboarding_submissions')
      .select('status')
      .eq('id', submissionId)
      .single();
    return { status: String(after?.status ?? 'pending') };
  }

  /**
   * Para expedientes ya aprobados en Bridge sin envío a Tazapay (p. ej. el
   * interruptor estaba apagado): crea la submission y la procesa.
   */
  async sendKybToTazapay(
    kybApplicationId: string,
  ): Promise<{ submissionId: string; status: string }> {
    const userId = await this.resolveUserId(
      'kyb_applications',
      kybApplicationId,
    );
    if (!userId) throw new NotFoundException('Expediente KYB no encontrado');
    const submissionId = await this.ensureSubmission(
      'tazapay',
      'kyb_applications',
      kybApplicationId,
      userId,
    );
    await this.processTazapaySubmission(submissionId);
    const { data } = await this.supabase
      .from('provider_onboarding_submissions')
      .select('status')
      .eq('id', submissionId)
      .single();
    return { submissionId, status: String(data?.status ?? 'pending') };
  }

  // ── Webhook de Tazapay ─────────────────────────────────────────────────

  /** entity.approval_* → estado de la submission y de la cuenta. */
  async applyTazapayEntityEvent(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const entityId = typeof data.id === 'string' ? data.id : null;
    if (!entityId) {
      this.logger.warn(`Webhook Tazapay ${eventType} sin data.id`);
      return;
    }
    const byEvent: Record<string, string> = {
      'entity.approval_processing': 'submitted',
      'entity.approval_requires_action': 'requires_action',
      'entity.approval_succeeded': 'approved',
      'entity.approval_rejected': 'rejected',
    };
    const rawStatus =
      typeof data.approval_status === 'string' ? data.approval_status : null;
    const normalized =
      byEvent[eventType] ?? TAZAPAY_STATUS_MAP[String(rawStatus)] ?? null;
    if (!normalized) {
      this.logger.log(
        `Webhook Tazapay ${eventType} ignorado (sin cambio de estado)`,
      );
      return;
    }

    const { data: submission } = await this.supabase
      .from('provider_onboarding_submissions')
      .select('id, user_id')
      .eq('provider', 'tazapay')
      .eq('external_id', entityId)
      .maybeSingle();
    if (!submission) {
      // No confiar en un id desconocido: puede ser una entity creada fuera de Guira.
      this.logger.warn(`Webhook Tazapay para entity desconocida ${entityId}`);
      return;
    }

    const now = new Date().toISOString();
    const reason =
      typeof data.approval_status_description === 'string'
        ? data.approval_status_description
        : null;
    await this.finish(submission.id as string, {
      status: normalized,
      raw_status: rawStatus,
      response_payload: {
        approval_status: rawStatus,
        pending_documents: data.pending_documents ?? null,
      },
    });
    await this.upsertAccount(submission.user_id as string, 'tazapay', {
      external_id: entityId,
      status: ACCOUNT_STATUS[normalized] ?? 'submitted',
      raw_status: rawStatus,
      status_reason: reason,
      last_synced_at: now,
      ...(normalized === 'approved' ? { approved_at: now } : {}),
      ...(normalized === 'rejected' ? { rejected_at: now } : {}),
    });
  }

  // ── Trabajos periódicos ────────────────────────────────────────────────

  /**
   * Cada 5 minutos: reintenta envíos de Tazapay pendientes o fallidos
   * recuperables, y reconcilia los que llevan más de 24 h sin cambios
   * (por si se perdió un webhook).
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'tazapay-onboarding-worker' })
  async runWorker(): Promise<void> {
    if (!(await this.isTazapayEnabled()) || !this.tazapayKyb.isConfigured)
      return;

    const { data: retryable } = await this.supabase
      .from('provider_onboarding_submissions')
      .select('id')
      .eq('provider', 'tazapay')
      .eq('status', 'failed_retryable')
      .lt('attempt_count', MAX_ATTEMPTS)
      .limit(10);
    for (const row of retryable ?? []) {
      await this.processTazapaySubmission(row.id as string);
    }

    const staleBefore = new Date(
      Date.now() - STALE_SUBMITTED_HOURS * 3600_000,
    ).toISOString();
    const { data: stale } = await this.supabase
      .from('provider_onboarding_submissions')
      .select('id, user_id, external_id')
      .eq('provider', 'tazapay')
      .in('status', ['submitted', 'requires_action'])
      .not('external_id', 'is', null)
      .lt('updated_at', staleBefore)
      .limit(20);
    for (const row of stale ?? []) {
      try {
        const raw = await this.tazapayKyb.fetchEntityStatus(
          row.external_id as string,
        );
        const normalized = TAZAPAY_STATUS_MAP[String(raw)];
        if (!normalized) continue;
        await this.applyTazapayEntityEvent('entity.reconciled', {
          data: { id: row.external_id, approval_status: raw },
        });
      } catch (err) {
        this.logger.warn(
          `Reconciliación Tazapay ${String(row.id)}: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── Lectura para el panel de staff ─────────────────────────────────────

  async getProviderStatus(userId: string) {
    const [{ data: accounts }, { data: submissions }] = await Promise.all([
      this.supabase
        .from('provider_accounts')
        .select(
          'provider, external_id, status, raw_status, status_reason, approved_at, rejected_at, updated_at',
        )
        .eq('user_id', userId),
      this.supabase
        .from('provider_onboarding_submissions')
        .select(
          'id, provider, kyc_application_id, kyb_application_id, status, raw_status, external_id, ineligibility_reason, attempt_count, last_error_code, last_error_message, submitted_at, updated_at',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false }),
    ]);
    return {
      tazapay_enabled: await this.isTazapayEnabled(),
      accounts: accounts ?? [],
      submissions: submissions ?? [],
    };
  }
}

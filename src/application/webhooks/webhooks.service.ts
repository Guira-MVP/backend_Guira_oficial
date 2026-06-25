import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { BridgeApiClient } from '../bridge/bridge-api.client';
import { WalletsService } from '../wallets/wallets.service';
import { ComplianceActionsService } from '../compliance/compliance-actions.service';
import { OrdersGateway } from '../orders/orders.gateway';
import { AdminGateway } from '../admin/admin.gateway';
import { EmailService } from '../email/email.service';
import { PaymentOrdersService } from '../payment-orders/payment-orders.service';

interface SinkEventDto {
  provider: string;
  event_type: string;
  provider_event_id: string | null;
  raw_payload: Record<string, unknown>;
  // Buffer crudo de la petición — requerido para verificación de firma Bridge
  raw_body: Buffer;
  headers: Record<string, string | null>;
  bridge_api_version: string | null;
}

interface WebhookEventContext {
  webhookEventId: string;
  providerEventId: string | null;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly config: ConfigService,
    private readonly bridgeApi: BridgeApiClient,
    private readonly walletsService: WalletsService,
    private readonly complianceActions: ComplianceActionsService,
    private readonly ordersGateway: OrdersGateway,
    private readonly adminGateway: AdminGateway,
    private readonly emailService: EmailService,
    private readonly paymentOrdersService: PaymentOrdersService,
  ) {}

  /**
   * Envía el correo de notificación cuando una orden ("expediente") llega a un
   * estado final (completed/failed) vía webhook de Bridge. Fire-and-forget:
   * nunca lanza, solo loggea.
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

  // ═══════════════════════════════════════════════
  //  WS HELPER — Emite hacia usuario Y staff
  // ═══════════════════════════════════════════════

  /**
   * Emite en un único paso:
   *   1. `profile_status_updated` al usuario afectado (namespace /orders)
   *   2. `user_updated` al room `staff` (namespace /admin)
   *
   * Se consulta el perfil actualizado para garantizar que el payload de
   * `user_updated` refleje el estado real persisitido en DB, no una
   * estimación construida a mano.
   */
  private async emitProfileStatusAndUserUpdate(
    userId: string,
    onboardingStatus: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    // Notificación inmediata al usuario (no necesita la fila completa)
    this.ordersGateway.emitProfileStatusUpdated(userId, {
      user_id: userId,
      onboarding_status: onboardingStatus,
      updated_at: now,
    });

    // Notificación al staff con datos reales de la fila actualizada
    const { data: profile } = await this.supabase
      .from('profiles')
      .select(
        'id, role, is_active, is_frozen, frozen_reason, onboarding_status, bridge_customer_id, updated_at',
      )
      .eq('id', userId)
      .single();

    if (!profile) return;

    this.adminGateway.emitUserUpdated({
      id: profile.id,
      role: profile.role,
      is_active: profile.is_active,
      is_frozen: profile.is_frozen,
      frozen_reason: profile.frozen_reason ?? null,
      onboarding_status: profile.onboarding_status,
      bridge_customer_id: profile.bridge_customer_id ?? null,
      updated_at: profile.updated_at ?? now,
    });
  }

  // ═══════════════════════════════════════════════
  //  WEBHOOK SINK — Persiste y responde 200
  // ═══════════════════════════════════════════════

  async sinkEvent(dto: SinkEventDto): Promise<void> {
    // Verificar firma ANTES del INSERT mientras el raw body original está en memoria.
    // Esta es la única oportunidad de verificar de forma fidedigna — en el CRON el
    // body ha sido re-serializado desde JSON y no coincide byte a byte con el original.
    const signatureHeader = dto.headers['x-webhook-signature'] ?? null;
    const signatureVerified = this.verifyBridgeSignature(
      dto.raw_body,
      signatureHeader,
    );

    if (!signatureVerified) {
      this.logger.warn(
        `⚠️  Firma Bridge no verificada para evento ${dto.provider_event_id ?? dto.event_type}`,
      );
    }

    const { error } = await this.supabase.from('webhook_events').insert({
      provider: dto.provider,
      event_type: dto.event_type,
      provider_event_id: dto.provider_event_id,
      raw_payload: dto.raw_payload,
      headers: dto.headers,
      bridge_api_version: dto.bridge_api_version,
      status: 'pending',
      signature_verified: signatureVerified, // valor real, no hardcoded false
    });

    if (error) {
      if (error.code === '23505') {
        this.logger.warn(`Evento duplicado ignorado: ${dto.provider_event_id}`);
        return;
      }
      this.logger.error(`Error guardando webhook: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════
  //  CRON WORKER — Cada 30s, FIFO, max 50
  // ═══════════════════════════════════════════════

  @Cron('*/30 * * * * *', { name: 'process-webhooks' })
  async processWebhooks(): Promise<void> {
    // ── 1. Rescatar eventos atascados en 'processing' por más de 2 minutos ──────
    // Ocurre cuando el proceso fue interrumpido a mitad del processOne().
    const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: stuckEvents } = await this.supabase
      .from('webhook_events')
      .select('id')
      .eq('status', 'processing')
      .lt('processing_started_at', stuckCutoff)
      .lt('retry_count', 5)
      .limit(10);

    if (stuckEvents && stuckEvents.length > 0) {
      this.logger.warn(
        `🔄 Rescatando ${stuckEvents.length} evento(s) atascados en 'processing'`,
      );
      await this.supabase
        .from('webhook_events')
        .update({ status: 'pending' })
        .in(
          'id',
          stuckEvents.map((e) => e.id),
        );
    }

    // ── 2. Reclamar y procesar eventos pendientes de forma atómica ───────────────
    // La RPC usa SELECT ... FOR UPDATE SKIP LOCKED: dos ticks del CRON que se
    // solapen nunca obtendrán el mismo evento, eliminando la race condition que
    // podría duplicar wallets u otras operaciones idempotentes.
    const { data: events, error } = await this.supabase.rpc(
      'claim_pending_webhooks',
      { batch_size: 50 },
    );

    if (error) {
      this.logger.error(`CRON error al reclamar webhooks: ${error.message}`);
      return;
    }
    if (!events || events.length === 0) return;

    this.logger.log(`⚙️  CRON: procesando ${events.length} webhook(s)`);

    for (const event of events) {
      await this.processOne(event);
    }
  }

  private async processOne(event: Record<string, unknown>): Promise<void> {
    const id = event.id as string;

    await this.supabase
      .from('webhook_events')
      .update({
        status: 'processing',
        processing_started_at: new Date().toISOString(),
      })
      .eq('id', id);

    try {
      // La firma ya fue verificada en sinkEvent() con el raw body original.
      // Aquí solo leemos el resultado guardado — NO re-verificamos con un buffer
      // re-serializado desde JSON (no coincide byte a byte con el original de Bridge).
      const signatureVerified = event.signature_verified as boolean;

      if (!signatureVerified) {
        if (this.config.get('app.nodeEnv') === 'production') {
          this.logger.warn(
            `❌ Firma inválida en evento ${id} — ignorado en producción`,
          );
          // Audit trail de firma inválida para detectar ataques de webhook injection
          void this.supabase.from('audit_logs').insert({
            performed_by: null,
            role: 'system',
            action: 'WEBHOOK_SIGNATURE_INVALID',
            table_name: 'webhook_events',
            record_id: id,
            new_values: {
              provider: 'bridge',
              event_type: event.event_type,
            },
            source: 'webhook',
          });
          await this.supabase
            .from('webhook_events')
            .update({ status: 'ignored' })
            .eq('id', id);
          return;
        }
        // En no-producción se permite continuar para facilitar el testing,
        // pero se registra explícitamente para no pasar desapercibido.
        this.logger.warn(
          `⚠️  Firma NO verificada en evento ${id} — procesando solo porque NODE_ENV=${this.config.get('app.nodeEnv')}`,
        );
      }

      // Despachar
      const eventType = event.event_type as string;
      const payload = event.raw_payload as Record<string, unknown>;
      await this.dispatchEvent(eventType, payload, {
        webhookEventId: id,
        providerEventId: (event.provider_event_id as string | null) ?? null,
      });

      // Marcar procesado
      await this.supabase
        .from('webhook_events')
        .update({ status: 'processed', processed_at: new Date().toISOString() })
        .eq('id', id);

      this.logger.log(`✅ Webhook procesado: ${eventType} (${id})`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`❌ Error procesando webhook ${id}: ${message}`);

      const retryCount = ((event.retry_count as number) ?? 0) + 1;
      const newStatus = retryCount >= 5 ? 'failed' : 'pending';

      await this.supabase
        .from('webhook_events')
        .update({
          status: newStatus,
          retry_count: retryCount,
          last_error: message,
        })
        .eq('id', id);

      // Si falla 5 veces → notificar admin
      if (retryCount >= 5) {
        await this.notifyAdminWebhookFailed(
          id,
          event.event_type as string,
          message,
        );
      }
    }
  }

  // ═══════════════════════════════════════════════
  //  DISPATCHER
  // ═══════════════════════════════════════════════

  private async dispatchEvent(
    eventType: string,
    payload: Record<string, unknown>,
    context?: WebhookEventContext,
  ): Promise<void> {
    // Los event types aquí deben coincidir EXACTAMENTE con los que Bridge envía.
    // Bridge usa event_type en formato "category.verb" o "category.verb.qualifier".
    switch (eventType) {
      // ── Customer lifecycle ────────────────────────────────────────────────────
      case 'customer.created':
        await this.handleCustomerCreated(payload);
        break;
      case 'customer.updated.status_transitioned':
        await this.handleCustomerUpdated(payload);
        break;
      case 'customer.updated':
        // Bridge envía este evento por cambios en endorsements/capabilities sin
        // transición de status. Solo sincronizamos bridge_customer_id; no
        // ejecutamos el flujo de aprobación para evitar correos duplicados.
        await this.handleCustomerUpdatedNonTransition(payload);
        break;

      // ── KYC link lifecycle ────────────────────────────────────────────────────
      case 'kyc_link.created':
        // Solo log — no hay acción de negocio requerida en creación
        this.logger.log(`kyc_link.created: ${payload?.event_object_id}`);
        break;
      case 'kyc_link.updated.status_transitioned':
        await this.handleKycLinkStatusTransitioned(payload);
        break;
      // Alias legacy — Bridge enviaba este tipo en versiones anteriores
      case 'kyc_link.approved':
        await this.handleKycLinkStatusTransitioned(payload);
        break;

      // ── Transfers ─────────────────────────────────────────────────────────────
      case 'transfer.created':
        this.logger.log(`transfer.created: ${payload?.event_object_id}`);
        break;
      case 'transfer.updated.status_transitioned':
      case 'transfer.updated': {
        const data = (payload.event_object || payload.data) as Record<
          string,
          unknown
        >;
        const state = data?.state as string;
        if (state === 'payment_processed') {
          await this.handleTransferPaymentProcessed(payload, context);
        } else if (state === 'complete' || state === 'completed') {
          await this.handleTransferComplete(payload, undefined, context);
        } else if (state === 'failed' || state === 'returned') {
          await this.handleTransferFailed(payload);
        } else {
          this.logger.log(
            `transfer status_transitioned a ${state} - actualizando bridge_state sin acción adicional`,
          );
          if (state && data?.id) {
            await this.supabase
              .from('bridge_transfers')
              .update({
                bridge_state: state,
                updated_at: new Date().toISOString(),
              })
              .eq('bridge_transfer_id', data.id as string);
          }
        }
        break;
      }
      // Alias legacy
      case 'transfer.payment_processed':
        await this.handleTransferPaymentProcessed(payload, context);
        break;
      case 'transfer.complete':
        await this.handleTransferComplete(payload, undefined, context);
        break;
      case 'transfer.failed':
        await this.handleTransferFailed(payload);
        break;

      // ── Virtual accounts (Bridge category: virtual_account.activity.*) ────────
      // IMPORTANTE: Bridge envía el prefijo de categoría completo en event_type.
      // Aliases sin prefijo mantenidos por compatibilidad con tests/sandbox manual.
      case 'virtual_account.activity.funds_received':
      case 'virtual_account.funds_received': // alias legacy/sandbox
        await this.handleVaFundsReceived(payload);
        break;

      case 'virtual_account.activity.payment_submitted':
      case 'virtual_account.payment_submitted':
        await this.handleVaPaymentSubmitted(payload);
        break;

      case 'virtual_account.activity.payment_processed':
      case 'virtual_account.payment_processed':
        await this.handleVaPaymentProcessed(payload);
        break;

      case 'virtual_account.activity.funds_scheduled':
      case 'virtual_account.funds_scheduled':
        await this.handleVaFundsScheduled(payload);
        break;

      case 'virtual_account.activity.in_review':
      case 'virtual_account.in_review':
        await this.handleVaInReview(payload);
        break;

      case 'virtual_account.activity.refund_in_flight':
      case 'virtual_account.refund_in_flight':
        await this.handleVaRefundInFlight(payload);
        break;

      case 'virtual_account.activity.refunded':
      case 'virtual_account.refunded':
        await this.handleVaRefunded(payload);
        break;

      case 'virtual_account.activity.refund_failed':
      case 'virtual_account.refund_failed':
        await this.handleVaRefundFailed(payload);
        break;

      case 'virtual_account.activity.microdeposit':
      case 'virtual_account.microdeposit':
        await this.handleVaMicrodeposit(payload);
        break;

      case 'virtual_account.activity.account_update':
      case 'virtual_account.account_update':
        await this.handleVaAccountUpdate(payload);
        break;

      case 'virtual_account.activity.activation':
      case 'virtual_account.activation':
        this.logger.log(
          `VA activada: ${payload?.event_object_id ?? 'unknown'}`,
        );
        break;

      case 'virtual_account.activity.deactivation':
      case 'virtual_account.deactivation':
        this.logger.log(
          `VA desactivada: ${payload?.event_object_id ?? 'unknown'}`,
        );
        break;

      // Bridge envía el sub-tipo de actividad dentro del payload (event_object.type)
      // en lugar de diferenciarlo en el event_type top-level. Estos dos casos
      // extraen el sub-tipo y re-despachan al handler específico correspondiente.
      case 'virtual_account.activity.created':
      case 'virtual_account.activity.updated': {
        const vaObj = (payload.event_object ??
          (payload.data as Record<string, unknown>)?.object) as
          | Record<string, unknown>
          | undefined;
        const vaSubType = vaObj?.type as string | undefined;
        if (vaSubType) {
          this.logger.log(
            `VA activity ${eventType} → re-dispatch como virtual_account.activity.${vaSubType}`,
          );
          await this.dispatchEvent(
            `virtual_account.activity.${vaSubType}`,
            payload,
          );
        } else {
          this.logger.warn(
            `virtual_account.activity sin sub-tipo en payload — ignorado`,
          );
        }
        break;
      }

      // ── Liquidation ───────────────────────────────────────────────────────────
      case 'liquidation_address.payment_completed':
        await this.handleLiquidationPayment(payload);
        break;

      // ── Liquidation Address Drains (bolivia_to_world) ──────────────────────
      case 'liquidation_address.drain.created':
        await this.handleDrainCreated(payload);
        break;
      case 'liquidation_address.drain.updated.status_transitioned':
        await this.handleDrainUpdated(payload);
        break;

      default:
        this.logger.warn(
          `⚠️ Evento Bridge sin handler: ${eventType} — registrado pero no procesado`,
        );
    }
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: customer.created
  //  Bridge confirma que el customer fue creado. Persistimos el bridge_customer_id
  //  si a\u00fan no está guardado (el approveReview ya lo guarda, esto es idempotente).
  // ═══════════════════════════════════════════════

  private async handleCustomerCreated(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventObject = payload.event_object as
      | Record<string, unknown>
      | undefined;
    const customerId = eventObject?.id as string | undefined;
    const email = eventObject?.email as string | undefined;

    if (!customerId || !email) {
      this.logger.warn('customer.created: payload sin id o email');
      return;
    }

    // Buscar perfil por email y guardar bridge_customer_id si aún no está
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('id, bridge_customer_id')
      .eq('email', email)
      .maybeSingle();

    if (!profile) {
      this.logger.warn(
        `customer.created: no se encontró profile para email ${email}`,
      );
      return;
    }

    if (!profile.bridge_customer_id) {
      await this.supabase
        .from('profiles')
        .update({ bridge_customer_id: customerId })
        .eq('id', profile.id);
      this.logger.log(
        `customer.created: bridge_customer_id ${customerId} guardado para user ${profile.id}`,
      );
    }
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: customer.updated / customer.updated.status_transitioned
  //  Cuando Bridge cambia el status del customer (ej. incomplete → active),
  //  actualizamos el perfil y \u2014 si llega a active \u2014 inicializamos wallets.
  // ═══════════════════════════════════════════════

  private async handleCustomerUpdated(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventObject = payload.event_object as
      | Record<string, unknown>
      | undefined;
    const customerId = eventObject?.id as string | undefined;
    const email = eventObject?.email as string | undefined;
    const newStatus = payload.event_object_status as string | undefined;

    if (!customerId || !email) return;

    const { data: profile } = await this.supabase
      .from('profiles')
      .select('id, bridge_customer_id, onboarding_status')
      .eq('email', email)
      .maybeSingle();

    if (!profile) {
      this.logger.warn(
        `customer.updated: no se encontró profile para email ${email}`,
      );
      return;
    }

    // Actualizar bridge_customer_id si aún no está
    if (!profile.bridge_customer_id) {
      await this.supabase
        .from('profiles')
        .update({ bridge_customer_id: customerId })
        .eq('id', profile.id);
    }

    // ═══ FLUJO PRINCIPAL: actuar según el status de Bridge ═══

    if (newStatus === 'active') {
      // Idempotencia: si el perfil ya fue aprobado en un webhook anterior
      // (puede ocurrir cuando Bridge envía status_transitioned + customer.updated
      // casi simultáneamente), omitir para no duplicar correos ni acciones.
      if (profile.onboarding_status === 'approved') {
        this.logger.log(
          `customer.updated: customer ${customerId} ya aprobado (onboarding_status=approved), skip`,
        );
        return;
      }

      // ── APROBACIÓN FINAL ──
      // Bridge confirmó que el customer está verificado.
      // ESTE es el único punto que marca la cuenta como 'approved'.
      this.logger.log(
        `customer.updated: customer ${customerId} → active, aprobando cuenta`,
      );

      // Determinar tipo de aplicación y aprobar
      const { data: kycApp } = await this.supabase
        .from('kyc_applications')
        .select('id')
        .eq('user_id', profile.id)
        .in('status', [
          'sent_to_bridge',
          'submitted',
          'under_review',
          'pending',
          'needs_review',
        ])
        .maybeSingle();

      if (kycApp) {
        await this.supabase
          .from('kyc_applications')
          .update({
            status: 'approved',
            approved_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', kycApp.id);
      } else {
        // Try KYB
        await this.supabase
          .from('kyb_applications')
          .update({
            status: 'approved',
            approved_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', profile.id)
          .in('status', [
            'sent_to_bridge',
            'submitted',
            'under_review',
            'pending',
            'needs_review',
          ]);
      }

      // Actualizar perfil a approved
      await this.supabase
        .from('profiles')
        .update({
          onboarding_status: 'approved',
          bridge_customer_id: customerId,
        })
        .eq('id', profile.id);

      // WS: notificar al cliente y al staff que la cuenta fue aprobada
      await this.emitProfileStatusAndUserUpdate(profile.id, 'approved');

      // Inicializar wallets
      await this.initializeWalletsForUser(profile.id, customerId);

      // Cerrar compliance review y registrar audit log
      await this.complianceActions.handleBridgeApproval(profile.id, customerId);

      // Notificación al cliente
      await this.supabase.from('notifications').insert({
        user_id: profile.id,
        type: 'onboarding',
        title: 'Verificación Aprobada',
        message:
          'Tu verificación ha sido aprobada. Ya puedes operar en la plataforma.',
      });

      this.logger.log(
        `✅ customer.updated: customer ${customerId} → active, wallets inicializadas para user ${profile.id}`,
      );
    } else if (newStatus === 'rejected') {
      // ── RECHAZO POR BRIDGE ──
      // Extraer issues del payload si están disponibles
      const rejectionReasons = this.extractBridgeIssues(eventObject);

      this.logger.warn(
        `customer.updated: customer ${customerId} → rejected. Issues: ${rejectionReasons.join(', ')}`,
      );

      // Delegar al ComplianceActionsService para manejar rechazo
      await this.complianceActions.handleBridgeRejection(
        profile.id,
        customerId,
        rejectionReasons,
      );
    } else if (newStatus === 'incomplete' || newStatus === 'under_review') {
      // ── KYC INCOMPLETO / EN REVISIÓN EN BRIDGE ──
      // Bridge reporta issues que requieren atención del staff.
      // Solo actuamos si el perfil ya fue enviado a Bridge (pending_bridge),
      // para distinguir del estado transitorio inicial de creación.
      if (profile.onboarding_status === 'pending_bridge') {
        const { issueSet, additionalRequirements } =
          this.extractEndorsementIssues(eventObject);

        const hasBlockingIssues =
          issueSet.size > 0 ||
          additionalRequirements.includes('kyc_approval') ||
          additionalRequirements.includes('pending_rfi');

        if (hasBlockingIssues) {
          await this.applyBridgeBlockingIssues(
            profile,
            customerId,
            [...issueSet],
            additionalRequirements,
            newStatus,
          );
        } else {
          this.logger.log(
            `customer.updated: customer ${customerId} → ${newStatus} (transitorio, sin issues bloqueantes)`,
          );
        }
      } else {
        this.logger.log(
          `customer.updated: customer ${customerId} → ${newStatus} (onboarding_status=${profile.onboarding_status}, sin acción)`,
        );
      }
    } else {
      this.logger.log(
        `customer.updated: status=${newStatus} para customer ${customerId} — sin acción final`,
      );
    }
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: customer.updated  (sin transición de estado)
  //  Bridge envía este evento cuando cambian endorsements o capabilities
  //  pero el status del customer no cambia. Solo sincronizamos bridge_customer_id.
  //  NO ejecutar flujo de aprobación para evitar correos duplicados.
  // ═══════════════════════════════════════════════

  private async handleCustomerUpdatedNonTransition(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventObject = payload.event_object as
      | Record<string, unknown>
      | undefined;
    const customerId = eventObject?.id as string | undefined;
    const email = eventObject?.email as string | undefined;

    if (!customerId || !email) return;

    const { data: profile } = await this.supabase
      .from('profiles')
      .select('id, bridge_customer_id')
      .eq('email', email)
      .maybeSingle();

    if (!profile) return;

    if (!profile.bridge_customer_id) {
      await this.supabase
        .from('profiles')
        .update({ bridge_customer_id: customerId })
        .eq('id', profile.id);
    }

    this.logger.log(
      `customer.updated (non-transition): customer ${customerId} — solo sync bridge_customer_id`,
    );
  }

  /**
   * Extrae los issues bloqueantes y los additional_requirements de los
   * endorsements de un customer.updated (usado para status 'incomplete' y 'under_review').
   */
  private extractEndorsementIssues(
    eventObject: Record<string, unknown> | undefined,
  ): { issueSet: Set<string>; additionalRequirements: string[] } {
    const endorsements =
      (eventObject?.endorsements as
        | Array<Record<string, unknown>>
        | undefined) ?? [];

    // Extraer issues de cada endorsement (deduplicados)
    const issueSet = new Set<string>();
    for (const endorsement of endorsements) {
      const requirements = endorsement.requirements as
        | Record<string, unknown>
        | undefined;
      if (requirements && Array.isArray(requirements.issues)) {
        for (const issue of requirements.issues) {
          if (typeof issue === 'string') {
            issueSet.add(issue);
          } else if (typeof issue === 'object' && issue !== null) {
            // Bridge usa formato: { "acting_as_intermediary": ["incomplete_sof_field"] }
            for (const [key, val] of Object.entries(
              issue as Record<string, unknown>,
            )) {
              if (Array.isArray(val)) {
                val.forEach((v) => issueSet.add(`${key}: ${v}`));
              } else {
                issueSet.add(`${key}: ${String(val)}`);
              }
            }
          }
        }
      }
    }

    const additionalRequirements: string[] = [];
    for (const endorsement of endorsements) {
      const addReqs = endorsement.additional_requirements as
        | string[]
        | undefined;
      if (Array.isArray(addReqs)) {
        addReqs.forEach((r) => additionalRequirements.push(r));
      }
    }

    return { issueSet, additionalRequirements };
  }

  /**
   * Marca el perfil como 'kyc_issues', persiste los issues reportados por Bridge
   * en la kyc_application y delega al ComplianceActionsService para registrar
   * el evento en el historial del compliance review y notificar al staff.
   *
   * Idempotente: si los mismos issues ya fueron registrados (p.ej. tras un
   * "Re-enviar a Bridge" que produjo la misma respuesta), no duplica el
   * evento ni las notificaciones.
   */
  private async applyBridgeBlockingIssues(
    profile: { id: string; onboarding_status: string | null },
    customerId: string,
    issuesList: string[],
    additionalRequirements: string[],
    bridgeStatus: 'incomplete' | 'under_review',
  ): Promise<void> {
    const { data: kycApp } = await this.supabase
      .from('kyc_applications')
      .select('observations')
      .eq('user_id', profile.id)
      .in('status', [
        'sent_to_bridge',
        'submitted',
        'under_review',
        'needs_review',
      ])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const previousIssues = this.parsePreviousBridgeIssues(kycApp?.observations);
    if (previousIssues && this.sameIssueSet(previousIssues, issuesList)) {
      this.logger.log(
        `customer.updated: customer ${customerId} → ${bridgeStatus} con los mismos issues ya registrados (${issuesList.join(', ')}), sin duplicar evento/notificación`,
      );
      return;
    }

    const observationsPayload = {
      bridge_status: bridgeStatus,
      issues: issuesList,
      additional_requirements: additionalRequirements,
      detected_at: new Date().toISOString(),
    };

    this.logger.warn(
      `customer.updated: customer ${customerId} → ${bridgeStatus} con issues bloqueantes: ${issuesList.join(', ')}`,
    );

    // Marcar perfil como kyc_issues para que sea visible en el dashboard
    await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'kyc_issues' })
      .eq('id', profile.id);

    // WS: notificar al cliente y al staff que hay issues en su verificación
    await this.emitProfileStatusAndUserUpdate(profile.id, 'kyc_issues');

    // Guardar los issues en el KYC application
    await this.supabase
      .from('kyc_applications')
      .update({
        observations: JSON.stringify(observationsPayload),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', profile.id)
      .in('status', ['sent_to_bridge', 'submitted', 'under_review']);

    // Delegar al ComplianceActionsService:
    // - registra evento en historial del compliance review
    // - notifica a cada miembro del staff (con detalle de issues)
    // - notifica al cliente con mensaje genérico
    // - inserta audit_log permanente
    await this.complianceActions.handleBridgeIncomplete(
      profile.id,
      customerId,
      issuesList,
      additionalRequirements,
      bridgeStatus,
    );

    this.logger.warn(
      `⚠️ customer.updated: perfil ${profile.id} marcado como kyc_issues (bridge_status=${bridgeStatus}). Staff notificado vía compliance review.`,
    );
  }

  private parsePreviousBridgeIssues(observations: unknown): string[] | null {
    if (typeof observations !== 'string' || !observations) return null;
    try {
      const parsed = JSON.parse(observations) as { issues?: unknown };
      return Array.isArray(parsed.issues) ? (parsed.issues as string[]) : null;
    } catch {
      return null;
    }
  }

  private sameIssueSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].slice().sort();
    const sortedB = [...b].slice().sort();
    return sortedA.every((val, idx) => val === sortedB[idx]);
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: kyc_link.updated.status_transitioned
  //  Este es el evento REAL que Bridge envía cuando el KYC es aprobado.
  //  Usa event_object (no data). Ejecuta la lógica de aprobación completa.
  // ═══════════════════════════════════════════════

  private async handleKycLinkStatusTransitioned(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventObject = payload.event_object as
      | Record<string, unknown>
      | undefined;
    const kycStatus = eventObject?.kyc_status as string | undefined;
    const customerId = eventObject?.customer_id as string | undefined;
    const email = eventObject?.email as string | undefined;
    const customerType = (eventObject?.type as string) ?? 'individual';

    if (!customerId) {
      this.logger.warn(
        'kyc_link.updated.status_transitioned: payload sin customer_id',
      );
      return;
    }

    // Buscar perfil por bridge_customer_id o email
    let profile: { id: string; onboarding_status: string | null } | null = null;

    const { data: byCustomerId } = await this.supabase
      .from('profiles')
      .select('id, onboarding_status')
      .eq('bridge_customer_id', customerId)
      .maybeSingle();
    profile = byCustomerId;

    if (!profile && email) {
      const { data: byEmail } = await this.supabase
        .from('profiles')
        .select('id, onboarding_status')
        .eq('email', email)
        .maybeSingle();
      profile = byEmail;
    }

    if (!profile) {
      this.logger.warn(
        `kyc_link.updated.status_transitioned: no se encontró profile para customer ${customerId}`,
      );
      return;
    }

    const userId = profile.id;
    const typeLabel = customerType === 'business' ? 'KYB' : 'KYC';

    if (kycStatus === 'approved') {
      // Idempotencia: el handler de customer.updated.status_transitioned puede
      // haber llegado milisegundos antes y ya aprobado la cuenta. Si es así,
      // evitar duplicar correo y acciones de aprobación.
      if (profile.onboarding_status === 'approved') {
        this.logger.log(
          `kyc_link.updated.status_transitioned: customer ${customerId} ya aprobado (onboarding_status=approved), skip`,
        );
        return;
      }

      // ── APROBACIÓN FINAL vía KYC Link ──

      // Actualizar la aplicación correcta según tipo de customer
      if (customerType === 'business') {
        await this.supabase
          .from('kyb_applications')
          .update({
            status: 'approved',
            approved_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .in('status', [
            'sent_to_bridge',
            'submitted',
            'under_review',
            'pending',
            'needs_review',
          ]);
      } else {
        await this.supabase
          .from('kyc_applications')
          .update({
            status: 'approved',
            approved_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .in('status', [
            'sent_to_bridge',
            'submitted',
            'under_review',
            'pending',
            'needs_review',
          ]);
      }

      // Actualizar perfil
      await this.supabase
        .from('profiles')
        .update({
          onboarding_status: 'approved',
          bridge_customer_id: customerId,
        })
        .eq('id', userId);

      // WS: notificar al cliente y al staff que su verificación fue aprobada
      await this.emitProfileStatusAndUserUpdate(userId, 'approved');

      // Inicializar wallets
      await this.initializeWalletsForUser(userId, customerId);

      // Cerrar compliance review
      await this.complianceActions.handleBridgeApproval(userId, customerId);

      // Notificación
      await this.supabase.from('notifications').insert({
        user_id: userId,
        type: 'onboarding',
        title: `Verificación ${typeLabel} Aprobada`,
        message: `Tu verificación ${typeLabel} ha sido aprobada. Ya puedes operar en la plataforma.`,
      });

      // Activity log
      await this.supabase.from('activity_logs').insert({
        user_id: userId,
        action: `${typeLabel}_APPROVED_WEBHOOK`,
        description: `Verificación ${typeLabel} confirmada por Bridge webhook — customer: ${customerId}`,
      });

      this.logger.log(
        `✅ kyc_link aprobado para customer ${customerId} (user ${userId})`,
      );
    } else if (kycStatus === 'rejected' || kycStatus === 'failed') {
      // ── RECHAZO vía KYC Link ──
      const rejectionReasons = this.extractBridgeIssues(eventObject);

      this.logger.warn(
        `kyc_link.updated.status_transitioned: kyc_status=${kycStatus} para customer ${customerId} — Issues: ${rejectionReasons.join(', ')}`,
      );

      // Delegar al ComplianceActionsService
      await this.complianceActions.handleBridgeRejection(
        userId,
        customerId,
        rejectionReasons,
      );

      // Activity log
      await this.supabase.from('activity_logs').insert({
        user_id: userId,
        action: `${typeLabel}_REJECTED_WEBHOOK`,
        description: `Verificación ${typeLabel} rechazada por Bridge — Issues: ${rejectionReasons.join(', ')}`,
      });
    } else {
      this.logger.log(
        `kyc_link.updated.status_transitioned: kyc_status=${kycStatus} — sin acción`,
      );
    }
  }

  // ═══════════════════════════════════════════════
  //  HELPER: Extrae el nombre del remitente segun el payment_rail [FIX M-2]
  //  ACH/SEPA/SPEI/PIX -> source.sender_name | Wire -> source.originator_name
  // ═══════════════════════════════════════════════

  private extractVaSenderName(
    source: Record<string, unknown> | undefined,
  ): string {
    if (!source) return 'Desconocido';
    const rail = source.payment_rail as string | undefined;
    if (rail === 'wire') {
      return (source.originator_name as string) ?? 'Desconocido';
    }
    return (source.sender_name as string) ?? 'Desconocido';
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.funds_received [FIX C-1, C-2, C-3]
  //  Bridge recibio el deposito fiat — NO acreditamos balance aqui.
  //  La acreditacion ocurre en handleVaPaymentProcessed (estado terminal).
  // ═══════════════════════════════════════════════

  private async handleVaFundsReceived(
    payload: Record<string, unknown>,
  ): Promise<void> {
    // FIX C-2: event_object es la fuente de datos para eventos VA
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    if (!data)
      throw new Error('VA funds_received: payload sin event_object/data');

    const vaId = data.virtual_account_id as string;
    const depositId = (data.deposit_id as string) ?? null;
    const amount = parseFloat(data.amount as string);
    const currency = ((data.currency as string) ?? 'usd').toUpperCase();
    const source = data.source as Record<string, unknown> | undefined;
    const senderName = this.extractVaSenderName(source);
    const paymentRail = (source?.payment_rail as string) ?? null;
    const bridgeEventId = (data.id as string) ?? null;

    if (!vaId || isNaN(amount)) {
      throw new Error(
        `VA funds_received: payload invalido — vaId=${vaId} amount=${amount}`,
      );
    }

    // 1. Buscar VA
    const { data: va, error: vaErr } = await this.supabase
      .from('bridge_virtual_accounts')
      .select(
        'id, user_id, destination_wallet_id, source_currency, destination_currency, developer_fee_percent, is_external_sweep, destination_address, external_destination_label',
      )
      .eq('bridge_virtual_account_id', vaId)
      .single();

    if (vaErr || !va) throw new Error(`VA no encontrada: ${vaId}`);

    // 2. Idempotencia: evitar doble procesamiento del mismo deposito [FIX C-5]
    if (depositId) {
      const { data: existing } = await this.supabase
        .from('payment_orders')
        .select('id')
        .eq('deposit_id', depositId)
        .maybeSingle();

      if (existing) {
        this.logger.warn(
          `VA funds_received: deposit_id ${depositId} ya existe (order ${existing.id}) — ignorando`,
        );
        return;
      }
    }

    // 3. Registrar en bridge_virtual_account_events (auditoria)
    await this.supabase.from('bridge_virtual_account_events').insert({
      bridge_virtual_account_id: vaId,
      bridge_event_id: bridgeEventId,
      deposit_id: depositId,
      event_type: 'virtual_account.activity.funds_received',
      amount,
      currency,
      sender_name: senderName,
      payment_rail: paymentRail,
      raw_payload: payload,
    });

    // 4. Calcular fee
    const devFeePercent =
      va.developer_fee_percent != null
        ? parseFloat(String(va.developer_fee_percent))
        : 0;
    const feeAmount = parseFloat(((amount * devFeePercent) / 100).toFixed(2));
    const netAmount = parseFloat((amount - feeAmount).toFixed(2));

    // 5. Bifurcar: external sweep vs deposito interno
    if (va.is_external_sweep) {
      await this.handleExternalSweepDeposit(
        va,
        amount,
        feeAmount,
        netAmount,
        currency,
        senderName,
        payload,
        depositId,
      );
    } else {
      await this.handleInternalDepositPending(
        va,
        amount,
        feeAmount,
        netAmount,
        currency,
        senderName,
        bridgeEventId,
        depositId,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  CASO A: Deposito Interno (fondos se quedan en Guira) — ETAPA 1: PENDING
  //  Crea la payment_order en estado 'pending'. La acreditacion del balance
  //  ocurre en handleVaPaymentProcessed cuando Bridge confirma on-chain. [FIX C-3]
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleInternalDepositPending(
    va: Record<string, unknown>,
    amount: number,
    feeAmount: number,
    netAmount: number,
    currency: string,
    senderName: string,
    bridgeEventId: string | null,
    depositId: string | null,
  ): Promise<void> {
    const userId = va.user_id as string;

    // Obtener wallet interna del usuario
    let walletId = va.destination_wallet_id as string | null;
    if (!walletId) {
      const { data: wallet } = await this.supabase
        .from('wallets')
        .select('id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .limit(1)
        .single();
      if (!wallet) throw new Error(`Wallet no encontrada para user ${userId}`);
      walletId = wallet.id;
    }

    // Crear payment_order en 'pending' — NO se acredita balance todavia
    const { data: order } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        wallet_id: walletId,
        source_type: 'bridge_virtual_account',
        source_reference_id: va.id,
        flow_type: 'va_deposit',
        flow_category: 'inbound',
        amount,
        fee_amount: feeAmount,
        net_amount: netAmount,
        currency: ((va.destination_currency as string) ?? 'USDC').toUpperCase(),
        source_currency: (
          (va.source_currency as string) ?? currency
        ).toUpperCase(),
        // Depósito fiat → stablecoin es a la par; el webhook payment_processed
        // sobreescribe con receipt.exchange_rate cuando Bridge confirma.
        exchange_rate_applied: 1.0,
        sender_name: senderName,
        bridge_event_id: bridgeEventId,
        deposit_id: depositId,
        va_deposit_status: 'funds_received',
        status: 'pending',
      })
      .select('id')
      .single();

    // WS: notificar a staff sobre nueva orden VA deposit pending
    if (order?.id) {
      this.ordersGateway.emitOrderCreated({
        id: order.id,
        user_id: userId,
        flow_type: 'va_deposit',
        flow_category: 'inbound',
        amount,
        currency: ((va.source_currency as string) ?? currency).toUpperCase(),
        status: 'pending',
        created_at: new Date().toISOString(),
      });
    }

    // Notificar al usuario que el deposito esta en proceso (no acreditado aun)
    await this.supabase.from('notifications').insert({
      user_id: userId,
      type: 'financial',
      title: 'Deposito en Proceso',
      message: `Recibimos $${amount.toFixed(2)} de ${senderName}. Tu balance se actualizara cuando Bridge confirme el pago.`,
      reference_type: 'payment_order',
      reference_id: order?.id ?? null,
    });

    // Activity log
    await this.supabase.from('activity_logs').insert({
      user_id: userId,
      action: 'VA_DEPOSIT_PENDING',
      description: `Deposito VA recibido: $${amount} de ${senderName} — pendiente confirmacion on-chain`,
    });

    this.logger.log(
      `VA deposito pendiente: $${netAmount} para user ${userId} (order ${order?.id ?? 'N/A'})`,
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  CASO B: External Sweep (Doble Asiento — Balance Neto $0)
  //  Los fondos ya salieron a Binance, MetaMask, etc.
  //  Credit + Debit inmediato = Balance Guira no se altera.
  // ═══════════════════════════════════════════════════════════

  private async handleExternalSweepDeposit(
    va: Record<string, unknown>,
    amount: number,
    feeAmount: number,
    netAmount: number,
    currency: string,
    senderName: string,
    payload: Record<string, unknown>,
    depositId: string | null = null,
  ): Promise<void> {
    const userId = va.user_id as string;
    const externalAddr =
      (va.destination_address as string) ?? 'Externa desconocida';
    const externalLabel =
      (va.external_destination_label as string) ?? externalAddr;

    // Wallet de referencia interna (para el asiento contable aunque los fondos no se queden)
    const { data: refWallet } = await this.supabase
      .from('wallets')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .limit(1)
      .single();

    if (!refWallet)
      throw new Error(`Wallet de referencia no encontrada para user ${userId}`);
    const refWalletId = refWallet.id;

    // 1. INSERT payment_order con status 'swept_external'
    const { data: order } = await this.supabase
      .from('payment_orders')
      .insert({
        user_id: userId,
        wallet_id: refWalletId,
        source_type: 'bridge_virtual_account',
        source_reference_id: va.id,
        flow_type: 'va_deposit',
        flow_category: 'inbound',
        amount,
        fee_amount: feeAmount,
        net_amount: netAmount,
        currency: ((va.source_currency as string) ?? currency).toUpperCase(),
        exchange_rate_applied: 1.0,
        sender_name: senderName,
        bridge_event_id: (payload.id as string) ?? null,
        deposit_id: depositId,
        va_deposit_status: 'payment_processed',
        status: 'swept_external',
      })
      .select('id')
      .single();

    const orderId = order?.id ?? null;

    // WS: notificar a staff sobre nueva orden swept_external
    if (order?.id) {
      this.ordersGateway.emitOrderCreated({
        id: order.id,
        user_id: userId,
        flow_type: 'va_deposit',
        flow_category: 'inbound',
        amount,
        currency: ((va.source_currency as string) ?? currency).toUpperCase(),
        status: 'swept_external',
        created_at: new Date().toISOString(),
      });
    }

    // 2. DOBLE ASIENTO CONTABLE (Credit + Debit instantáneo)
    //    Ambos con status 'settled' para que los triggers se procesen y se cancelen mutuamente.

    // Asiento 1: CRÉDITO — "El dinero entró desde la cuenta virtual"
    await this.supabase.from('ledger_entries').insert({
      wallet_id: refWalletId,
      type: 'credit',
      amount: netAmount,
      currency: (va.source_currency as string) ?? currency,
      status: 'settled',
      reference_type: 'payment_order',
      reference_id: orderId,
      description: `Depósito recibido — ${senderName} ($${amount}) [External Sweep]`,
    });

    // Asiento 2: DÉBITO — "El dinero salió automáticamente a wallet externa"
    await this.supabase.from('ledger_entries').insert({
      wallet_id: refWalletId,
      type: 'debit',
      amount: netAmount,
      currency: (va.source_currency as string) ?? currency,
      status: 'settled',
      reference_type: 'payment_order',
      reference_id: orderId,
      description: `Auto-sweep a wallet externa: ${externalLabel} (${externalAddr})`,
    });

    // 3. Notificación al cliente — informar que los fondos ya salieron
    await this.supabase.from('notifications').insert({
      user_id: userId,
      type: 'financial',
      title: 'Depósito Reenviado a Wallet Externa',
      message: `$${netAmount.toFixed(2)} de ${senderName} fue reenviado automáticamente a ${externalLabel} (fee: $${feeAmount.toFixed(2)})`,
      reference_type: 'payment_order',
      reference_id: orderId,
    });

    // 4. Activity log
    await this.supabase.from('activity_logs').insert({
      user_id: userId,
      action: 'DEPOSIT_EXTERNAL_SWEEP',
      description: `Depósito de $${amount} de ${senderName} → auto-sweep a ${externalLabel} (${externalAddr}). Neto: $${netAmount} (fee: $${feeAmount})`,
    });

    this.logger.log(
      `🔀 External sweep: $${netAmount} para user ${userId} → ${externalAddr}`,
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.payment_submitted  [NEW]
  //  Bridge envio el pago on-chain; actualiza el estado de la order.
  // ═══════════════════════════════════════════════════════════

  private async handleVaPaymentSubmitted(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    const depositId = (data?.deposit_id as string) ?? null;
    const vaId = data?.virtual_account_id as string;

    this.logger.log(`VA payment_submitted: depositId=${depositId} va=${vaId}`);

    await this.supabase.from('bridge_virtual_account_events').insert({
      bridge_virtual_account_id: vaId,
      bridge_event_id: (data?.id as string) ?? null,
      deposit_id: depositId,
      event_type: 'virtual_account.activity.payment_submitted',
      amount: parseFloat((data?.amount as string) ?? '0'),
      currency: ((data?.currency as string) ?? 'usd').toUpperCase(),
      raw_payload: payload,
    });

    if (depositId) {
      await this.supabase
        .from('payment_orders')
        .update({ va_deposit_status: 'payment_submitted' })
        .eq('deposit_id', depositId)
        .not(
          'status',
          'in',
          '("completed","refunded","cancelled","swept_external")',
        );
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.payment_processed  [NEW — FIX C-3]
  //  Estado terminal de exito. AQUI se acredita el balance.
  // ═══════════════════════════════════════════════════════════

  private async handleVaPaymentProcessed(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    if (!data)
      throw new Error('VA payment_processed: payload sin event_object/data');

    const depositId = (data.deposit_id as string) ?? null;
    const vaId = data.virtual_account_id as string;

    // Extraer campos del receipt para persistirlos en la order
    const receipt = (data.receipt as Record<string, unknown>) ?? null;
    const txHash = (data.destination_tx_hash as string) ?? null;
    const receiptUrl = (receipt?.url as string) ?? null;
    const bridgeFinalAmount = receipt?.final_amount
      ? parseFloat(receipt.final_amount as string)
      : null;
    // developer_fee_amount en event_object y receipt.developer_fee son equivalentes;
    // usamos el del receipt como fuente canónica, con fallback al nivel superior.
    const bridgeDeveloperFee =
      receipt?.developer_fee != null
        ? parseFloat(receipt.developer_fee as string)
        : data.developer_fee_amount != null
          ? parseFloat(data.developer_fee_amount as string)
          : null;
    const destinationNetwork =
      (data.destination_payment_rail as string) ?? null;
    const destinationCurrency = (data.currency as string) ?? null;
    // Tasa de cambio de Bridge (receipt.exchange_rate). En va_deposit la conversión
    // fiat → stablecoin es a la par, por lo que el fallback es 1.0 si Bridge no la envía.
    const bridgeExchangeRate =
      receipt?.exchange_rate != null
        ? parseFloat(receipt.exchange_rate as string)
        : 1.0;

    this.logger.log(
      `VA payment_processed: depositId=${depositId} va=${vaId} tx=${txHash ?? 'n/a'}`,
    );

    // Registrar evento
    await this.supabase.from('bridge_virtual_account_events').insert({
      bridge_virtual_account_id: vaId,
      bridge_event_id: (data.id as string) ?? null,
      deposit_id: depositId,
      event_type: 'virtual_account.activity.payment_processed',
      amount: parseFloat((data.amount as string) ?? '0'),
      currency: ((data.currency as string) ?? 'usd').toUpperCase(),
      raw_payload: payload,
    });

    // Buscar payment_order pendiente por deposit_id
    const { data: order } = await this.supabase
      .from('payment_orders')
      .select('id, user_id, wallet_id, net_amount, currency, va_deposit_status')
      .eq('deposit_id', depositId ?? '')
      .eq('status', 'pending')
      .maybeSingle();

    if (!order) {
      // Re-entrega sobre orden ya completada: solo corregir va_deposit_status si hace falta
      const { data: completedOrder } = await this.supabase
        .from('payment_orders')
        .select('id, va_deposit_status')
        .eq('deposit_id', depositId ?? '')
        .eq('status', 'completed')
        .maybeSingle();

      if (
        completedOrder &&
        completedOrder.va_deposit_status !== 'payment_processed'
      ) {
        await this.supabase
          .from('payment_orders')
          .update({ va_deposit_status: 'payment_processed' })
          .eq('id', completedOrder.id);
        this.logger.log(
          `VA payment_processed (re-delivery): va_deposit_status corregido a payment_processed para order ${completedOrder.id}`,
        );
      } else {
        this.logger.warn(
          `VA payment_processed: no hay order pendiente para deposit_id=${depositId}`,
        );
      }
      return;
    }

    if (order.va_deposit_status === 'refunded') {
      this.logger.warn(
        `VA payment_processed ignorado: order ${order.id} ya fue reembolsada`,
      );
      return;
    }

    // Bridge final_amount es el monto que realmente llega al wallet (autoridad)
    const creditAmount =
      bridgeFinalAmount ?? parseFloat(String(order.net_amount));

    // Acreditar balance: INSERT ledger_entry settled (trigger actualiza balances)
    await this.supabase.from('ledger_entries').insert({
      wallet_id: order.wallet_id,
      type: 'credit',
      amount: creditAmount,
      currency: order.currency,
      status: 'settled',
      reference_type: 'payment_order',
      reference_id: order.id,
      description: `Deposito confirmado via cuenta virtual Bridge`,
    });

    // Marcar order como completada y persistir datos del receipt.
    // fee_amount se sobreescribe con el developer_fee real de Bridge: fuente de verdad
    // para este flujo, ya que el fee se configura por VA y puede diferir del calculo local.
    await this.supabase
      .from('payment_orders')
      .update({
        status: 'completed',
        va_deposit_status: 'payment_processed',
        completed_at: new Date().toISOString(),
        fee_amount: bridgeDeveloperFee ?? undefined,
        net_amount: creditAmount,
        amount_destination: creditAmount,
        exchange_rate_applied: bridgeExchangeRate,
        destination_currency: destinationCurrency?.toUpperCase() ?? null,
        destination_network: destinationNetwork ?? null,
        tx_hash: txHash,
        receipt_url: receiptUrl,
      })
      .eq('id', order.id);

    // WS: notificar al usuario y staff que el VA deposit fue completado
    this.ordersGateway.emitOrderUpdated(order.user_id, {
      id: order.id,
      user_id: order.user_id,
      status: 'completed',
      flow_type: 'va_deposit',
      updated_at: new Date().toISOString(),
    });

    // Notificacion de credito exitoso
    await this.supabase.from('notifications').insert({
      user_id: order.user_id,
      type: 'financial',
      title: 'Deposito Confirmado',
      message: `$${creditAmount.toFixed(2)} ${order.currency} acreditados en tu wallet Guira.`,
      reference_type: 'payment_order',
      reference_id: order.id,
    });

    await this.supabase.from('activity_logs').insert({
      user_id: order.user_id,
      action: 'VA_DEPOSIT_CONFIRMED',
      description: `Deposito VA confirmado: $${creditAmount} acreditados (order ${order.id})`,
    });

    this.logger.log(
      `✅ VA deposito confirmado: $${creditAmount} ${order.currency} para user ${order.user_id}`,
    );
  }

  // ═══════════════════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.funds_scheduled  [NEW — P2-B]
  //  ACH: fondos en transito. Notificar al usuario con fecha estimada.
  // ═══════════════════════════════════════════════════════════

  private async handleVaFundsScheduled(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    const vaId = data?.virtual_account_id as string;
    const depositId = (data?.deposit_id as string) ?? null;
    const amount = parseFloat((data?.amount as string) ?? '0');
    const source = data?.source as Record<string, unknown> | undefined;
    const estimatedArrival = (source?.estimated_arrival_date as string) ?? null;

    this.logger.log(
      `VA funds_scheduled: va=${vaId} amount=${amount} eta=${estimatedArrival}`,
    );

    await this.supabase.from('bridge_virtual_account_events').insert({
      bridge_virtual_account_id: vaId,
      bridge_event_id: (data?.id as string) ?? null,
      deposit_id: depositId,
      event_type: 'virtual_account.activity.funds_scheduled',
      amount,
      currency: ((data?.currency as string) ?? 'usd').toUpperCase(),
      payment_rail: (source?.payment_rail as string) ?? null,
      raw_payload: payload,
    });

    // Buscar user_id desde la VA para notificar
    const { data: va } = await this.supabase
      .from('bridge_virtual_accounts')
      .select('user_id')
      .eq('bridge_virtual_account_id', vaId)
      .single();

    if (va?.user_id) {
      const etaText = estimatedArrival
        ? ` Tu deposito ACH llegara aproximadamente el ${estimatedArrival}.`
        : '';
      await this.supabase.from('notifications').insert({
        user_id: va.user_id,
        type: 'financial',
        title: 'Deposito ACH en Camino',
        message: `Detectamos un deposito de $${amount.toFixed(2)} en transito hacia tu cuenta virtual.${etaText}`,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.in_review  [NEW — P3-E]
  //  Fondos bajo revision de cumplimiento; el balance NO se acredita.
  // ═══════════════════════════════════════════════════════════

  private async handleVaInReview(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    const vaId = data?.virtual_account_id as string;
    const depositId = (data?.deposit_id as string) ?? null;
    const amount = parseFloat((data?.amount as string) ?? '0');

    this.logger.warn(
      `VA in_review: va=${vaId} depositId=${depositId} amount=${amount}`,
    );

    await this.supabase.from('bridge_virtual_account_events').insert({
      bridge_virtual_account_id: vaId,
      bridge_event_id: (data?.id as string) ?? null,
      deposit_id: depositId,
      event_type: 'virtual_account.activity.in_review',
      amount,
      currency: ((data?.currency as string) ?? 'usd').toUpperCase(),
      raw_payload: payload,
    });

    if (depositId) {
      await this.supabase
        .from('payment_orders')
        .update({ va_deposit_status: 'in_review' })
        .eq('deposit_id', depositId);
    }

    const { data: va } = await this.supabase
      .from('bridge_virtual_accounts')
      .select('user_id')
      .eq('bridge_virtual_account_id', vaId)
      .single();

    if (va?.user_id) {
      await this.supabase.from('notifications').insert({
        user_id: va.user_id,
        type: 'compliance',
        title: 'Deposito en Revision',
        message: `Tu deposito de $${amount.toFixed(2)} esta siendo revisado por el equipo de cumplimiento. Te notificaremos cuando se resuelva.`,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.refund_in_flight  [NEW — C-4]
  //  Reembolso iniciado; marcar la order como en proceso de devolucion.
  // ═══════════════════════════════════════════════════════════

  private async handleVaRefundInFlight(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    const vaId = data?.virtual_account_id as string;
    const depositId = (data?.deposit_id as string) ?? null;
    const amount = parseFloat((data?.amount as string) ?? '0');

    this.logger.warn(`VA refund_in_flight: va=${vaId} depositId=${depositId}`);

    await this.supabase.from('bridge_virtual_account_events').insert({
      bridge_virtual_account_id: vaId,
      bridge_event_id: (data?.id as string) ?? null,
      deposit_id: depositId,
      event_type: 'virtual_account.activity.refund_in_flight',
      amount,
      currency: ((data?.currency as string) ?? 'usd').toUpperCase(),
      raw_payload: payload,
    });

    if (depositId) {
      await this.supabase
        .from('payment_orders')
        .update({ va_deposit_status: 'refund_in_flight' })
        .eq('deposit_id', depositId);
    }

    const { data: va } = await this.supabase
      .from('bridge_virtual_accounts')
      .select('user_id')
      .eq('bridge_virtual_account_id', vaId)
      .single();

    if (va?.user_id) {
      await this.supabase.from('notifications').insert({
        user_id: va.user_id,
        type: 'financial',
        title: 'Reembolso en Proceso',
        message: `Tu deposito de $${amount.toFixed(2)} esta siendo devuelto al remitente original.`,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.refunded  [NEW — FIX C-4 CRITICO]
  //  Reembolso completado. Revertir credito si el balance ya fue acreditado.
  // ═══════════════════════════════════════════════════════════

  private async handleVaRefunded(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    if (!data) throw new Error('VA refunded: payload sin event_object/data');

    const vaId = data.virtual_account_id as string;
    const depositId = (data.deposit_id as string) ?? null;
    const amount = parseFloat((data.amount as string) ?? '0');

    this.logger.warn(
      `VA refunded: va=${vaId} depositId=${depositId} amount=${amount}`,
    );

    await this.supabase.from('bridge_virtual_account_events').insert({
      bridge_virtual_account_id: vaId,
      bridge_event_id: (data.id as string) ?? null,
      deposit_id: depositId,
      event_type: 'virtual_account.activity.refunded',
      amount,
      currency: ((data.currency as string) ?? 'usd').toUpperCase(),
      raw_payload: payload,
    });

    // Buscar la payment_order asociada
    const { data: order } = await this.supabase
      .from('payment_orders')
      .select(
        'id, user_id, wallet_id, net_amount, currency, status, va_deposit_status',
      )
      .eq('deposit_id', depositId ?? '')
      .maybeSingle();

    if (!order) {
      this.logger.warn(
        `VA refunded: no se encontro order para deposit_id=${depositId}`,
      );
      return;
    }

    // Si la order ya fue completada (balance acreditado), revertir con un debit
    if (order.status === 'completed') {
      const netAmount = parseFloat(String(order.net_amount));

      await this.supabase.from('ledger_entries').insert({
        wallet_id: order.wallet_id,
        type: 'debit',
        amount: netAmount,
        currency: order.currency,
        status: 'settled',
        reference_type: 'payment_order',
        reference_id: order.id,
        description: `Reversa de deposito Bridge \u2014 reembolso al remitente`,
        metadata: { reason: 'va_deposit_refunded', deposit_id: depositId },
      });

      this.logger.warn(
        `⚠️ Reversa de $${netAmount} aplicada a wallet ${order.wallet_id} (order ${order.id} reembolsada)`,
      );
    }

    // Marcar order como reembolsada
    await this.supabase
      .from('payment_orders')
      .update({ status: 'refunded', va_deposit_status: 'refunded' })
      .eq('id', order.id);

    // WS: notificar al usuario y staff que el VA deposit fue reembolsado
    this.ordersGateway.emitOrderUpdated(order.user_id, {
      id: order.id,
      user_id: order.user_id,
      status: 'refunded',
      flow_type: 'va_deposit',
      updated_at: new Date().toISOString(),
    });

    await this.supabase.from('notifications').insert({
      user_id: order.user_id,
      type: 'financial',
      title: 'Deposito Reembolsado',
      message: `Tu deposito de $${amount.toFixed(2)} fue devuelto al remitente. Si tu balance ya habia sido acreditado, ha sido corregido automaticamente.`,
      reference_type: 'payment_order',
      reference_id: order.id,
    });

    await this.supabase.from('activity_logs').insert({
      user_id: order.user_id,
      action: 'VA_DEPOSIT_REFUNDED',
      description: `Deposito VA reembolsado: $${amount} (deposit_id=${depositId})`,
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.refund_failed  [NEW — C-4]
  //  El intento de reembolso fallo. Requiere atencion manual.
  // ═══════════════════════════════════════════════════════════

  private async handleVaRefundFailed(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    const vaId = data?.virtual_account_id as string;
    const depositId = (data?.deposit_id as string) ?? null;
    const amount = parseFloat((data?.amount as string) ?? '0');

    this.logger.error(
      `VA refund_failed: va=${vaId} depositId=${depositId} amount=${amount}`,
    );

    await this.supabase.from('bridge_virtual_account_events').insert({
      bridge_virtual_account_id: vaId,
      bridge_event_id: (data?.id as string) ?? null,
      deposit_id: depositId,
      event_type: 'virtual_account.activity.refund_failed',
      amount,
      currency: ((data?.currency as string) ?? 'usd').toUpperCase(),
      raw_payload: payload,
    });

    if (depositId) {
      await this.supabase
        .from('payment_orders')
        .update({ va_deposit_status: 'refund_failed' })
        .eq('deposit_id', depositId);
    }

    // Solo log de error + audit — requiere intervencion manual
    await this.supabase.from('audit_logs').insert({
      performed_by: null,
      action: 'VA_REFUND_FAILED',
      table_name: 'bridge_virtual_account_events',
      new_values: { va_id: vaId, deposit_id: depositId, amount },
      source: 'webhook',
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.microdeposit  [NEW — P3-B]
  //  Microdeposito de verificacion: NUNCA se acredita al balance.
  // ═══════════════════════════════════════════════════════════

  private async handleVaMicrodeposit(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    const vaId = data?.virtual_account_id as string;
    const amount = parseFloat((data?.amount as string) ?? '0');

    this.logger.log(
      `VA microdeposit recibido (ignorado para balance): va=${vaId} amount=${amount}`,
    );

    await this.supabase.from('bridge_virtual_account_events').insert({
      bridge_virtual_account_id: vaId,
      bridge_event_id: (data?.id as string) ?? null,
      event_type: 'virtual_account.activity.microdeposit',
      amount,
      currency: ((data?.currency as string) ?? 'usd').toUpperCase(),
      raw_payload: payload,
    });
    // Microdepositos NO se acreditan — Bridge los maneja internamente para verificacion
  }

  // ═══════════════════════════════════════════════════════════
  //  HANDLER: virtual_account.activity.account_update  [NEW]
  //  La VA fue modificada por Bridge; actualizar registro local.
  // ═══════════════════════════════════════════════════════════

  private async handleVaAccountUpdate(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    const vaId = (data?.id as string) ?? (data?.virtual_account_id as string);
    const newStatus = (data?.status as string) ?? null;

    this.logger.log(`VA account_update: va=${vaId} newStatus=${newStatus}`);

    if (vaId && newStatus) {
      await this.supabase
        .from('bridge_virtual_accounts')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('bridge_virtual_account_id', vaId);
    }

    await this.supabase.from('audit_logs').insert({
      performed_by: null,
      action: 'VA_ACCOUNT_UPDATE',
      table_name: 'bridge_virtual_accounts',
      new_values: { bridge_virtual_account_id: vaId, status: newStatus },
      source: 'webhook',
    });
  }

  // ═══════════════════════════════════════════════

  private async handleTransferPaymentProcessed(
    payload: Record<string, unknown>,
    context?: WebhookEventContext,
  ): Promise<void> {
    // Redirigido a handleTransferComplete para finalizar automáticamente
    // órdenes de pago, ya que Bridge a menudo frena el ciclo en payment_processed.
    await this.handleTransferComplete(payload, 'payment_processed', context);
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: transfer.complete (REFACTORIZADO)
  //  [GAP 1 FIX] UPDATE ledger pending→settled, NO crear nuevo
  // ═══════════════════════════════════════════════

  private async handleTransferComplete(
    payload: Record<string, unknown>,
    bridgeState: string = 'complete',
    context?: WebhookEventContext,
  ): Promise<void> {
    const data = (payload?.event_object || payload?.data) as Record<
      string,
      unknown
    >;
    const bridgeTransferId = data?.id as string;
    if (!bridgeTransferId) throw new Error('transfer.complete sin transfer ID');

    const receipt = data?.receipt as Record<string, unknown> | undefined;
    const source = data?.source as Record<string, unknown> | undefined;
    const receiptFinalAmount = receipt?.final_amount
      ? parseFloat(receipt.final_amount as string)
      : null;
    const receiptExchangeFee = receipt?.exchange_fee
      ? parseFloat(receipt.exchange_fee as string)
      : null;
    // Tasa real que Bridge aplicó en la conversión (solo presente en transfers con FX).
    const receiptExchangeRate = receipt?.exchange_rate
      ? parseFloat(receipt.exchange_rate as string)
      : null;
    const destinationTxHash =
      (data?.destination_tx_hash as string | undefined) ??
      (receipt?.destination_tx_hash as string | undefined) ??
      null;
    const receiptUrl = (receipt?.url as string | undefined) ?? null;
    const sourceAddress =
      (source?.from_address as string | undefined) ??
      (source?.address as string | undefined) ??
      null;
    const sourceNetwork =
      (source?.payment_rail as string | undefined) ??
      (source?.network as string | undefined) ??
      null;
    const destination = data?.destination as
      | Record<string, unknown>
      | undefined;
    const traceNumber =
      (destination?.trace_number as string | undefined) ?? null;
    const destinationAddress =
      (destination?.to_address as string | undefined) ??
      (destination?.address as string | undefined) ??
      null;
    const destinationNetwork =
      (destination?.payment_rail as string | undefined) ??
      (destination?.network as string | undefined) ??
      null;
    const sourceTxHash =
      (receipt?.source_tx_hash as string | undefined) ?? null;

    // 1. UPDATE bridge_transfers
    // FIX #4: Usar maybeSingle() — si el INSERT de bridge_transfers falló previamente
    // (ej: por el bug del ledger), esta línea no debe romper el webhook.
    const { data: transfer } = await this.supabase
      .from('bridge_transfers')
      .update({
        bridge_state: bridgeState,
        status: 'completed',
        completed_at: new Date().toISOString(),
        receipt_initial_amount: receipt?.initial_amount ?? null,
        receipt_exchange_fee: receipt?.exchange_fee ?? null,
        receipt_developer_fee: receipt?.developer_fee ?? null,
        receipt_final_amount: receipt?.final_amount ?? null,
        destination_tx_hash: destinationTxHash,
        exchange_rate: receipt?.exchange_rate ?? null,
        bridge_raw_response: data,
        updated_at: new Date().toISOString(),
      })
      .eq('bridge_transfer_id', bridgeTransferId)
      .select('id, user_id, payout_request_id, amount')
      .maybeSingle();

    // FIX #4: Continuar aunque no se encuentre bridge_transfers — loguear warning
    // en lugar de lanzar excepción que marca el webhook como 'failed'.
    if (!transfer) {
      this.logger.warn(
        `⚠️ handleTransferComplete: bridge_transfer no encontrada para ID: ${bridgeTransferId}. ` +
          `Continuando con actualización de payment_order si existe.`,
      );
    }

    // 2. UPDATE payout_requests
    if (transfer?.payout_request_id) {
      await this.supabase
        .from('payout_requests')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', transfer.payout_request_id);
    }

    // 2b. UPDATE payment_orders (si el transfer está vinculado a una order)
    // FIX #3: Se agrega 'pending' a los estados válidos.
    // Si el servidor caía entre la respuesta de Bridge y el UPDATE de status='processing',
    // la orden queda en 'pending' indefinidamente sin este fix.
    const { data: paymentOrder } = await this.supabase
      .from('payment_orders')
      .select(
        'id, user_id, wallet_id, flow_type, amount, fee_amount, amount_destination, currency, source_currency, destination_currency, deposit_reference_code, receipt_url',
      )
      .eq('bridge_transfer_id', bridgeTransferId)
      .in('status', [
        'pending',
        'waiting_deposit',
        'processing',
        'deposit_received',
      ])
      .maybeSingle();

    if (paymentOrder) {
      // ── Guard: flujo de dos tramos (bridge_wallet_to_fiat_bo) ──
      // Tramo 1 (Bridge Transfer → PSAV) completado por webhook.
      // Tramo 2 (PSAV → BOB → cuenta usuario) debe ser gestionado por staff.
      const isDualLegFlow =
        paymentOrder.flow_type === 'bridge_wallet_to_fiat_bo';

      if (isDualLegFlow) {
        // Asentar ledger (debit confirmed on-chain) y liberar reserva en una sola
        // transacción atómica — evita la ventana donde available_amount sería negativo.
        const totalReserved = parseFloat(paymentOrder.amount ?? '0');
        const { error: settleBoError } = await this.supabase.rpc('settle_and_release_reserved', {
          p_user_id: paymentOrder.user_id,
          p_currency: (
            paymentOrder.source_currency ??
            paymentOrder.currency ??
            'USDC'
          ).toUpperCase(),
          p_amount: totalReserved,
          p_reference_id: paymentOrder.id,
        });
        if (settleBoError) {
          this.logger.error(
            `❌ settle_and_release_reserved falló para order ${paymentOrder.id}: ${settleBoError.message}`,
          );
          throw new Error(`settle_and_release_reserved failed: ${settleBoError.message}`);
        }

        // Notificar staff que el PSAV recibió el crypto
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
            title: 'Retiro BO — Crypto recibido por PSAV',
            message: `Orden ${paymentOrder.id}: Bridge confirmó que el PSAV recibió ${paymentOrder.amount} ${paymentOrder.currency}. Pendiente: conversión USDC→BOB y depósito a cuenta BO del cliente.`,
            reference_type: 'payment_order',
            reference_id: paymentOrder.id,
          }));
          await this.supabase.from('notifications').insert(notifications);
        }

        // Notificar al usuario que el primer tramo está listo
        await this.supabase.from('notifications').insert({
          user_id: paymentOrder.user_id,
          type: 'financial',
          title: 'Transferencia en Proceso',
          message: `Tu retiro de ${paymentOrder.amount} ${paymentOrder.currency} está siendo procesado. Recibirás tus bolivianos pronto.`,
          reference_type: 'payment_order',
          reference_id: paymentOrder.id,
        });

        this.logger.log(
          `🔄 Payment order ${paymentOrder.id} (bridge_wallet_to_fiat_bo): Tramo 1 completado — crypto en PSAV. Pendiente payout BOB manual.`,
        );
      } else {
        // Comportamiento original: marcar orden como completed
        const initialAmount = parseFloat(paymentOrder.amount ?? '0');
        await this.supabase
          .from('payment_orders')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            tx_hash: destinationTxHash,
            source_tx_hash: sourceTxHash,
            ...(receiptUrl ? { bridge_receipt_url: receiptUrl } : {}),
            provider_reference:
              traceNumber ??
              destinationTxHash ??
              context?.providerEventId ??
              null,
            bridge_event_id: context?.providerEventId ?? null,
            source_address: sourceAddress,
            source_network: sourceNetwork,
            destination_address: destinationAddress,
            destination_network: destinationNetwork,
            ...(receiptExchangeFee != null
              ? { exchange_fee: receiptExchangeFee }
              : {}),
            ...(receiptFinalAmount != null
              ? { amount_destination: receiptFinalAmount }
              : {}),
            // Para retiros bridge_wallet_to_fiat_us a divisas no-USD (MXN, EUR, BRL, COP, GBP):
            // sobreescribir con la tasa real de Bridge como fuente de verdad.
            ...(receiptExchangeRate != null &&
              paymentOrder.flow_type === 'bridge_wallet_to_fiat_us' &&
              (paymentOrder.destination_currency ?? '').toUpperCase() !== 'USD'
                ? { exchange_rate_applied: receiptExchangeRate }
                : {}),
            // Guardar metadata histórica si fue on-ramp flexible (amount original 0)
            ...(initialAmount === 0 && receipt?.initial_amount
              ? { amount: parseFloat(receipt.initial_amount as string) }
              : {}),
            ...(initialAmount === 0 && receipt?.developer_fee
              ? { fee_amount: parseFloat(receipt.developer_fee as string) }
              : {}),
            // net_amount = final_amount real (on-ramp flexible arranca en 0)
            ...(initialAmount === 0 && receiptFinalAmount != null
              ? { net_amount: receiptFinalAmount }
              : {}),
          })
          .eq('id', paymentOrder.id);

        // Para on-ramp flexible (amount=0 en creación), el monto real viene
        // del receipt de Bridge — usar ese valor en el correo al cliente.
        const emailOrder = {
          ...paymentOrder,
          amount:
            initialAmount === 0 && receipt?.initial_amount
              ? parseFloat(receipt.initial_amount as string)
              : paymentOrder.amount,
        };
        void this.notifyOrderFinalStatusEmail(emailOrder, 'completed');

        // WS: notificar al usuario y staff que la transferencia fue completada
        this.ordersGateway.emitOrderUpdated(paymentOrder.user_id, {
          id: paymentOrder.id,
          user_id: paymentOrder.user_id,
          status: 'completed',
          flow_type: paymentOrder.flow_type,
          updated_at: new Date().toISOString(),
        });

        // Para off-ramp: liberar la reserva ANTES de asentar el ledger.
        // El trigger update_balance_on_ledger_entry calcula:
        //   available = available + LEAST(0, v_diff + reserved)
        // Si released=0 ya, el resultado es correcto.
        // Si released≠0 al momento del settle, el trigger podría violar
        // CHECK (available >= 0) aunque el balance total sea suficiente.
        const offRampFlows = [
          'bridge_wallet_to_crypto',
          'bridge_wallet_to_fiat_us',
        ];
        if (offRampFlows.includes(paymentOrder.flow_type)) {
          const totalReserved = parseFloat(paymentOrder.amount ?? '0');
          if (totalReserved > 0) {
            await this.supabase.rpc('release_reserved_balance', {
              p_user_id: paymentOrder.user_id,
              p_currency: (
                paymentOrder.source_currency ??
                paymentOrder.currency ??
                'USDC'
              ).toUpperCase(),
              p_amount: totalReserved,
            });
            this.logger.log(
              `💰 Reserva liberada para order ${paymentOrder.id}: ${totalReserved} ${paymentOrder.currency}`,
            );
          }
        }

        // Asentar ledger entries vinculadas a la payment_order
        // Si tenemos receipt.final_amount de Bridge, actualizar el monto real recibido
        const { data: settledEntries, error: settleError } = await this.supabase
          .from('ledger_entries')
          .update({
            status: 'settled',
            ...(receiptFinalAmount != null
              ? { amount: receiptFinalAmount }
              : {}),
          })
          .eq('reference_type', 'payment_order')
          .eq('reference_id', paymentOrder.id)
          .eq('status', 'pending')
          .select('id');

        if (settleError) {
          this.logger.error(
            `❌ Error al asentar ledger entries para order ${paymentOrder.id}: ${settleError.message}`,
          );
          throw new Error(`Ledger settle failed for order ${paymentOrder.id}: ${settleError.message}`);
        }

        const settledCount = settledEntries?.length ?? 0;

        // Safety net: si no había ledger_entry pending para on-ramps,
        // crear uno settled directamente para que el trigger actualice balances.
        // IDEMPOTENCIA: verificar que no exista ya una settled entry antes de insertar
        // — un webhook retry con settledCount=0 volvería a crear otra entrada sin este check.
        const onRampFlows = [
          'crypto_to_bridge_wallet',
          'fiat_bo_to_bridge_wallet',
        ];
        if (
          settledCount === 0 &&
          paymentOrder.wallet_id &&
          onRampFlows.includes(paymentOrder.flow_type)
        ) {
          const { count: existingSettledCount } = await this.supabase
            .from('ledger_entries')
            .select('*', { count: 'exact', head: true })
            .eq('reference_type', 'payment_order')
            .eq('reference_id', paymentOrder.id)
            .eq('type', 'credit')
            .eq('status', 'settled');

          if ((existingSettledCount ?? 0) > 0) {
            this.logger.warn(
              `⚠️ Safety net omitida (idempotente): ya existe ledger_entry credit settled para order ${paymentOrder.id}`,
            );
          } else {
            // Usar receipt.final_amount (monto real) como fuente primaria.
            // Fallback: fiat_bo guarda `amount` en BOB — usar amount_destination (USDC) para no sobre-acreditar.
            // Otros on-ramp guardan `amount` ya en la moneda destino.
            const fallbackNet =
              paymentOrder.flow_type === 'fiat_bo_to_bridge_wallet'
                ? parseFloat(paymentOrder.amount_destination ?? '0')
                : parseFloat(paymentOrder.amount) -
                  parseFloat(paymentOrder.fee_amount ?? '0');
            const creditAmount = receiptFinalAmount ?? fallbackNet;

            const creditCurrency = (
              paymentOrder.destination_currency ?? paymentOrder.currency
            ).toUpperCase();
            await this.supabase.from('ledger_entries').insert({
              wallet_id: paymentOrder.wallet_id,
              type: 'credit',
              amount: creditAmount,
              currency: creditCurrency,
              status: 'settled',
              reference_type: 'payment_order',
              reference_id: paymentOrder.id,
              description: `On-ramp completado (webhook): ${creditAmount} ${creditCurrency}`,
            });
            this.logger.warn(
              `⚠️ Safety net: ledger_entry credit settled creado para order ${paymentOrder.id} — monto real: ${creditAmount}`,
            );
          }
        }

        // Notificación específica para on-ramp fiat_bo (el canal genérico de bridge_transfers
        // no siempre incluye el monto real en destCurrency — esta notificación lo hace explícito)
        if (paymentOrder.flow_type === 'fiat_bo_to_bridge_wallet') {
          const creditAmount =
            receiptFinalAmount ?? parseFloat(paymentOrder.amount ?? '0');
          const destCurrency = (
            paymentOrder.destination_currency ?? 'USDC'
          ).toUpperCase();
          await this.supabase.from('notifications').insert({
            user_id: paymentOrder.user_id,
            type: 'financial',
            title: 'Fondeo Completado',
            message: `Tu fondeo de ${creditAmount} ${destCurrency} ha sido acreditado en tu wallet Bridge.`,
            reference_type: 'payment_order',
            reference_id: paymentOrder.id,
          });
        }

        // Comprobante PSAV — generado automáticamente al completar fiat_bo_to_bridge_wallet (fire-and-forget)
        if (paymentOrder.flow_type === 'fiat_bo_to_bridge_wallet') {
          void this.paymentOrdersService.storePsavReceiptOnCompletion(paymentOrder.id);
        }

        this.logger.log(
          `✅ Payment order ${paymentOrder.id} completada vía webhook (transfer ${bridgeTransferId})`,
        );
      }
    }

    // FIX #4: Solo ejecutar operaciones dependientes de transfer si el registro existe
    if (transfer) {
      // 3. UPDATE ledger_entry existente: pending → settled
      // NO crear uno nuevo — el trigger de balance solo se activa al cambiar a settled
      // Aplica al flujo payout (BridgeService.executePayout) donde el ledger tiene
      // reference_type='payout_request' y se vincula por bridge_transfer_id (UUID local).
      const { error: settleTrError } = await this.supabase
        .from('ledger_entries')
        .update({ status: 'settled' })
        .eq('bridge_transfer_id', transfer.id)
        .eq('status', 'pending');
      if (settleTrError) {
        this.logger.error(
          `❌ Error al asentar ledger via bridge_transfer_id ${transfer.id}: ${settleTrError.message}`,
        );
        throw new Error(`Ledger settle (transfer path) failed: ${settleTrError.message}`);
      }

      // 4. INSERT certificate — idempotente: verificar que no exista ya uno para este transfer.
      //    Un webhook retry crearía un certificado duplicado sin este check.
      const { count: existingCertCount } = await this.supabase
        .from('certificates')
        .select('*', { count: 'exact', head: true })
        .eq('subject_type', 'bridge_transfer')
        .eq('subject_id', transfer.id);

      if ((existingCertCount ?? 0) === 0) {
        const certNumber = `CERT-${Date.now()}-${transfer.id.slice(0, 8)}`;
        await this.supabase.from('certificates').insert({
          user_id: transfer.user_id,
          subject_type: 'bridge_transfer',
          subject_id: transfer.id,
          certificate_number: certNumber,
          amount: transfer.amount,
          currency: (data?.destination_currency as string) ?? 'usd',
          issued_at: new Date().toISOString(),
          metadata: receipt ?? {},
        });
      }

      // 5. Notificación genérica — idempotente: solo insertar si no existe ya una para este transfer.
      //    Se omite también para fiat_bo_to_bridge_wallet (esa orden emite su propia notificación).
      if (paymentOrder?.flow_type !== 'fiat_bo_to_bridge_wallet') {
        const { count: existingNotifCount } = await this.supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('reference_type', 'bridge_transfer')
          .eq('reference_id', transfer.id)
          .eq('type', 'financial');

        if ((existingNotifCount ?? 0) === 0) {
          await this.supabase.from('notifications').insert({
            user_id: transfer.user_id,
            type: 'financial',
            title: 'Pago Completado',
            message: `Tu pago de $${transfer.amount} ha sido completado exitosamente`,
            reference_type: 'bridge_transfer',
            reference_id: transfer.id,
          });
        }
      }

      // 6. Activity log
      await this.supabase.from('activity_logs').insert({
        user_id: transfer.user_id,
        action: 'TRANSFER_COMPLETED',
        description: `Transfer ${bridgeTransferId} completado — $${transfer.amount}`,
      });
    } else {
      this.logger.warn(
        `⚠️ handleTransferComplete: Skipping certificate/notification para ${bridgeTransferId} — bridge_transfer no encontrada en DB.`,
      );
    }
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: transfer.failed (REFACTORIZADO)
  //  Libera reserved_amount + notifica
  // ═══════════════════════════════════════════════

  private async handleTransferFailed(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = (payload?.event_object || payload?.data) as Record<
      string,
      unknown
    >;
    const bridgeTransferId = data?.id as string;
    if (!bridgeTransferId) throw new Error('transfer.failed sin transfer ID');

    // 1. Leer estado actual ANTES del UPDATE para detectar procesamiento duplicado.
    //    Si transfer.complete ya fue procesado, no liberar el saldo reservado de nuevo
    //    (doble liberación produce reserved_amount negativo).
    const { data: existingTransfer } = await this.supabase
      .from('bridge_transfers')
      .select(
        'id, user_id, payout_request_id, amount, destination_currency, status',
      )
      .eq('bridge_transfer_id', bridgeTransferId)
      .maybeSingle();

    if (existingTransfer?.status === 'completed') {
      this.logger.warn(
        `⚠️ handleTransferFailed: transfer ${bridgeTransferId} ya tiene status='completed' — ` +
          `omitiendo liberación de saldo para evitar double-release. Solo actualizando bridge_state.`,
      );
      await this.supabase
        .from('bridge_transfers')
        .update({
          bridge_state: 'failed',
          bridge_raw_response: data,
          updated_at: new Date().toISOString(),
        })
        .eq('bridge_transfer_id', bridgeTransferId);
      return;
    }

    // 1b. UPDATE bridge_transfers
    const { data: transfer } = await this.supabase
      .from('bridge_transfers')
      .update({
        bridge_state: 'failed',
        status: 'failed',
        bridge_raw_response: data,
        updated_at: new Date().toISOString(),
      })
      .eq('bridge_transfer_id', bridgeTransferId)
      .select('id, user_id, payout_request_id, amount, destination_currency')
      .maybeSingle();

    if (!transfer) {
      this.logger.warn(
        `⚠️ handleTransferFailed: bridge_transfer no encontrada para ID: ${bridgeTransferId}. ` +
          `Continuando con actualización de payment_order si existe.`,
      );
    }

    // 2. UPDATE payout_requests (solo si tenemos el registro local)
    let payoutAmount = parseFloat(transfer?.amount ?? '0');
    let currency = transfer?.destination_currency ?? 'USD';

    if (transfer?.payout_request_id) {
      const { data: payout } = await this.supabase
        .from('payout_requests')
        .update({
          status: 'failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', transfer.payout_request_id)
        .select('amount, fee_amount, currency')
        .single();

      if (payout) {
        payoutAmount =
          parseFloat(payout.amount) + parseFloat(payout.fee_amount ?? '0');
        currency = payout.currency;
      }
    }

    // 3. UPDATE ledger_entry: pending → failed (solo si tenemos el registro local)
    if (transfer) {
      await this.supabase
        .from('ledger_entries')
        .update({ status: 'failed' })
        .eq('bridge_transfer_id', transfer.id)
        .eq('status', 'pending');
    }

    // 4b. UPDATE payment_orders — consultado ANTES del release para conocer flow_type y
    // moneda de origen (la moneda reservada puede diferir de destination_currency).
    // 'pending' incluido por paridad con handleTransferComplete (FIX #3 equivalente).
    const { data: failedOrder } = await this.supabase
      .from('payment_orders')
      .select(
        'id, user_id, wallet_id, amount, fee_amount, currency, flow_type, deposit_reference_code',
      )
      .eq('bridge_transfer_id', bridgeTransferId)
      .in('status', ['pending', 'processing', 'created', 'waiting_deposit'])
      .maybeSingle();

    // Flujos off-ramp de wallet reservan en source_currency (USDC), no en destination_currency.
    // Su liberación se hace en el bloque failedOrder usando failedOrder.currency (correcto).
    // Si se liberara aquí con transfer.destination_currency se usaría la moneda incorrecta (USD
    // para fiat_us) o se liberaría doble (USDC para crypto). Por eso se omite en esos casos.
    const offRampWalletFlows = [
      'bridge_wallet_to_crypto',
      'bridge_wallet_to_fiat_us',
    ];
    const isOffRampWalletFlow =
      failedOrder != null && offRampWalletFlows.includes(failedOrder.flow_type);

    // 4. Liberar saldo reservado (solo para flujos que no tienen liberación propia)
    if (transfer && !isOffRampWalletFlow) {
      await this.supabase.rpc('release_reserved_balance', {
        p_user_id: transfer.user_id,
        p_currency: currency.toUpperCase(),
        p_amount: payoutAmount,
      });
    }

    if (failedOrder) {
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'failed',
          failure_reason: `Bridge transfer ${bridgeTransferId} falló`,
        })
        .eq('id', failedOrder.id);

      void this.notifyOrderFinalStatusEmail(failedOrder, 'failed');

      // WS: notificar al usuario y staff que la orden falló
      this.ordersGateway.emitOrderUpdated(failedOrder.user_id, {
        id: failedOrder.id,
        user_id: failedOrder.user_id,
        status: 'failed',
        flow_type: failedOrder.flow_type,
        updated_at: new Date().toISOString(),
      });

      // Liberar balance reservado con la moneda de origen correcta (source_currency).
      // Solo aplica a flujos off-ramp wallet donde se hizo reserve_balance al inicio.
      const orderTotal = parseFloat(failedOrder.amount ?? '0');
      if (
        orderTotal > 0 &&
        offRampWalletFlows.includes(failedOrder.flow_type)
      ) {
        await this.supabase.rpc('release_reserved_balance', {
          p_user_id: failedOrder.user_id,
          p_currency: (failedOrder.currency ?? 'USDC').toUpperCase(),
          p_amount: orderTotal,
        });
      }

      // Marcar ledger entries como failed
      await this.supabase
        .from('ledger_entries')
        .update({ status: 'failed' })
        .eq('reference_type', 'payment_order')
        .eq('reference_id', failedOrder.id)
        .eq('status', 'pending');

      this.logger.warn(
        `❌ Payment order ${failedOrder.id} falló vía webhook (transfer ${bridgeTransferId})`,
      );
    }

    // 5. Notificación y activity log (solo si tenemos el registro local)
    if (transfer) {
      await this.supabase.from('notifications').insert({
        user_id: transfer.user_id,
        type: 'alert',
        title: 'Pago Fallido',
        message: `Tu pago de $${transfer.amount} falló. El saldo ha sido devuelto a tu cuenta.`,
        reference_type: 'bridge_transfer',
        reference_id: transfer.id,
      });

      await this.supabase.from('activity_logs').insert({
        user_id: transfer.user_id,
        action: 'TRANSFER_FAILED',
        description: `Transfer ${bridgeTransferId} falló — saldo liberado`,
      });
    } else {
      this.logger.warn(
        `⚠️ handleTransferFailed: notificación omitida para ${bridgeTransferId} — bridge_transfer no encontrada en DB.`,
      );
    }
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: kyc_link.approved (REFACTORIZADO)
  //  [GAP 2 FIX] Mismo evento para KYC y KYB
  // ═══════════════════════════════════════════════

  private async handleKycApproved(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = payload?.data as Record<string, unknown>;
    const kycLinkId = data?.id as string;
    if (!kycLinkId) throw new Error('kyc_link.approved sin link ID');

    // [GAP 2 FIX] Determinar tipo por customer.type
    const customer = data?.customer as Record<string, unknown> | undefined;
    const customerType = (customer?.type as string) ?? 'individual';
    const bridgeCustomerId = (customer?.id as string) ?? null;

    // Buscar en bridge_kyc_links
    const { data: link } = await this.supabase
      .from('bridge_kyc_links')
      .select('user_id')
      .eq('bridge_kyc_link_id', kycLinkId)
      .single();

    if (!link) throw new Error(`Bridge KYC link no encontrado: ${kycLinkId}`);
    const userId = link.user_id;

    // Actualizar bridge_kyc_links
    await this.supabase
      .from('bridge_kyc_links')
      .update({
        status: 'approved',
        bridge_customer_id: bridgeCustomerId,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('bridge_kyc_link_id', kycLinkId);

    // [GAP 2 FIX] Actualizar la aplicación correcta según tipo
    if (customerType === 'business') {
      await this.supabase
        .from('kyb_applications')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('status', ['submitted', 'under_review']);
    } else {
      await this.supabase
        .from('kyc_applications')
        .update({ status: 'approved', updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('status', ['submitted', 'under_review']);
    }

    // Actualizar perfil
    await this.supabase
      .from('profiles')
      .update({
        onboarding_status: 'approved',
        bridge_customer_id: bridgeCustomerId,
      })
      .eq('id', userId);

    // WS: notificar al cliente y al staff que su cuenta fue aprobada
    await this.emitProfileStatusAndUserUpdate(userId, 'approved');

    // Inicializar wallets y balances vía Bridge API
    await this.initializeWalletsForUser(userId, bridgeCustomerId);

    // Notificación
    const typeLabel = customerType === 'business' ? 'KYB' : 'KYC';
    await this.supabase.from('notifications').insert({
      user_id: userId,
      type: 'onboarding',
      title: `Verificación ${typeLabel} Aprobada`,
      message: `Tu verificación ${typeLabel} ha sido aprobada. Ya puedes operar en la plataforma.`,
    });

    // Activity log
    await this.supabase.from('activity_logs').insert({
      user_id: userId,
      action: `${typeLabel}_APPROVED`,
      description: `Verificación ${typeLabel} aprobada por Bridge — customer: ${bridgeCustomerId}`,
    });
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: liquidation_address.payment_completed
  // ═══════════════════════════════════════════════

  private async handleLiquidationPayment(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const data = payload?.data as Record<string, unknown>;
    const addressId = data?.liquidation_address_id as string;
    const amount = parseFloat((data?.amount as string) ?? '0');
    if (!addressId || !amount) throw new Error('liquidation payment sin datos');

    // Buscar dirección — columna correcta
    const { data: addr } = await this.supabase
      .from('bridge_liquidation_addresses')
      .select('id, user_id, destination_currency')
      .eq('bridge_liquidation_address_id', addressId)
      .single();

    if (!addr)
      throw new Error(`Liquidation address no encontrada: ${addressId}`);

    // Obtener wallet
    const { data: wallet } = await this.supabase
      .from('wallets')
      .select('id')
      .eq('user_id', addr.user_id)
      .eq('is_active', true)
      .limit(1)
      .single();

    if (!wallet)
      throw new Error(`Wallet no encontrada para user ${addr.user_id}`);

    // INSERT ledger_entry (credit, settled)
    await this.supabase.from('ledger_entries').insert({
      wallet_id: wallet.id,
      type: 'credit',
      amount,
      currency: addr.destination_currency ?? 'usd',
      description: `Liquidación crypto recibida — $${amount}`,
      reference_type: 'liquidation_address',
      reference_id: addr.id,
      status: 'settled',
    });

    // Notificación
    await this.supabase.from('notifications').insert({
      user_id: addr.user_id,
      type: 'financial',
      title: 'Liquidación Recibida',
      message: `Recibiste $${amount.toFixed(2)} de liquidación crypto`,
      reference_type: 'liquidation_address',
      reference_id: addr.id,
    });
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: liquidation_address.drain.created
  //  Match el drain con un expediente bolivia_to_world en processing
  //  usando monto + external_account_id del destino
  // ═══════════════════════════════════════════════

  private async handleDrainCreated(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventObject = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    const drainId = eventObject?.id as string;
    const amount = parseFloat((eventObject?.amount as string) ?? '0');
    const depositTxHash = (eventObject?.deposit_tx_hash as string) || null;
    const destination = eventObject?.destination as
      | Record<string, unknown>
      | undefined;

    if (!drainId || !amount) {
      this.logger.warn('⚠️ handleDrainCreated: payload sin drain ID o amount');
      return;
    }

    // Extraer el external_account_id o to_address del destino del drain
    const destExternalAccountId = destination?.external_account_id as
      | string
      | undefined;
    const destToAddress = destination?.to_address as string | undefined;

    this.logger.log(
      `🔔 Drain created: ${drainId} — amount: ${amount}, ` +
        `external_account_id: ${destExternalAccountId ?? 'N/A'}, ` +
        `to_address: ${destToAddress ?? 'N/A'}`,
    );

    // ── Matching por external_account_id (flujo bolivia_to_world) ──
    if (destExternalAccountId) {
      // Resolver el UUID interno de bridge_external_accounts a partir del bridge ID
      const { data: extAcct } = await this.supabase
        .from('bridge_external_accounts')
        .select('id')
        .eq('bridge_external_account_id', destExternalAccountId)
        .maybeSingle();

      if (extAcct) {
        // Buscar orden en processing que coincida por external_account_id y monto
        const { data: matchedOrder } = await this.supabase
          .from('payment_orders')
          .select(
            'id, user_id, amount, exchange_rate_applied, amount_destination',
          )
          .eq('status', 'processing')
          .in('flow_type', ['bolivia_to_world'])
          .eq('external_account_id', extAcct.id)
          .is('bridge_drain_id', null)
          .order('created_at', { ascending: true })
          .limit(10);

        // Comparar contra el monto bruto (amount / rate) que es lo que el PSAV deposita.
        // Bridge cobra el fee como developer_fee, así que el webhook trae el monto pre-fee.
        const tolerance = 0.02;
        const matched = (matchedOrder ?? []).find((o) => {
          const rate = parseFloat(o.exchange_rate_applied ?? '1');
          const grossAmount = parseFloat(o.amount ?? '0') / rate;
          return Math.abs(grossAmount - amount) <= tolerance;
        });

        if (matched) {
          await this.supabase
            .from('payment_orders')
            .update({ bridge_drain_id: drainId, source_tx_hash: depositTxHash })
            .eq('id', matched.id);

          // Audit log
          await this.supabase.from('audit_logs').insert({
            performed_by: null,
            action: 'DRAIN_MATCHED_TO_ORDER',
            table_name: 'payment_orders',
            record_id: matched.id,
            new_values: {
              bridge_drain_id: drainId,
              drain_amount: amount,
              matched_by: 'external_account_id + amount',
            },
            source: 'webhook',
          });

          this.logger.log(
            `✅ Drain ${drainId} vinculado a orden ${matched.id} (match por external_account + monto: ${amount})`,
          );
          return;
        }
      }
    }

    // ── Matching por to_address (flujo bolivia_to_wallet, futuro) ──
    if (destToAddress) {
      const { data: matchedByAddr } = await this.supabase
        .from('payment_orders')
        .select(
          'id, user_id, amount, exchange_rate_applied, amount_destination',
        )
        .eq('status', 'processing')
        .in('flow_type', ['bolivia_to_wallet'])
        .eq('destination_address', destToAddress)
        .is('bridge_drain_id', null)
        .order('created_at', { ascending: true })
        .limit(10);

      const tolerance = 0.02;
      const matched = (matchedByAddr ?? []).find((o) => {
        const rate = parseFloat(o.exchange_rate_applied ?? '1');
        const grossAmount = parseFloat(o.amount ?? '0') / rate;
        return Math.abs(grossAmount - amount) <= tolerance;
      });

      if (matched) {
        await this.supabase
          .from('payment_orders')
          .update({ bridge_drain_id: drainId, source_tx_hash: depositTxHash })
          .eq('id', matched.id);

        await this.supabase.from('audit_logs').insert({
          performed_by: null,
          action: 'DRAIN_MATCHED_TO_ORDER',
          table_name: 'payment_orders',
          record_id: matched.id,
          new_values: {
            bridge_drain_id: drainId,
            drain_amount: amount,
            matched_by: 'to_address + amount',
          },
          source: 'webhook',
        });

        this.logger.log(
          `✅ Drain ${drainId} vinculado a orden ${matched.id} (match por to_address + monto: ${amount})`,
        );
        return;
      }
    }

    // No se encontró match — log de advertencia para revisión manual
    this.logger.warn(
      `⚠️ Drain ${drainId} (amount: ${amount}) no pudo vincularse a ningún expediente en processing. ` +
        `Requiere revisión manual.`,
    );
  }

  // ═══════════════════════════════════════════════
  //  HANDLER: liquidation_address.drain.updated.status_transitioned
  //  Completa el expediente cuando Bridge confirma que el pago fiat
  //  llegó al destino (state: payment_processed)
  // ═══════════════════════════════════════════════

  private async handleDrainUpdated(
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventObject = (payload?.event_object ?? payload?.data) as Record<
      string,
      unknown
    >;
    const drainId = eventObject?.id as string;
    const state = (eventObject?.state ??
      payload?.event_object_status) as string;
    const receipt = eventObject?.receipt as Record<string, unknown> | undefined;
    const depositTxHash = (eventObject?.deposit_tx_hash as string) || null;

    if (!drainId) {
      this.logger.warn('⚠️ handleDrainUpdated: payload sin drain ID');
      return;
    }

    this.logger.log(`🔔 Drain updated: ${drainId} → state: ${state}`);

    // Solo procesamos la transición a payment_processed (pago fiat confirmado)
    if (state === 'payment_processed') {
      // Buscar la orden vinculada por bridge_drain_id
      const { data: order } = await this.supabase
        .from('payment_orders')
        .select('id, user_id, amount, amount_destination, currency, flow_type')
        .eq('bridge_drain_id', drainId)
        .eq('status', 'processing')
        .maybeSingle();

      if (!order) {
        // Podría ser un drain que no se vinculó en drain.created — intentar match ahora
        this.logger.warn(
          `⚠️ Drain ${drainId} con state=payment_processed pero sin orden vinculada. ` +
            `Intentando match tardío...`,
        );

        // Intentar vincular como en handleDrainCreated
        const destination = eventObject?.destination as
          | Record<string, unknown>
          | undefined;
        const destExternalAccountId = destination?.external_account_id as
          | string
          | undefined;
        const amount = parseFloat((eventObject?.amount as string) ?? '0');

        if (destExternalAccountId && amount > 0) {
          const { data: extAcct } = await this.supabase
            .from('bridge_external_accounts')
            .select('id')
            .eq('bridge_external_account_id', destExternalAccountId)
            .maybeSingle();

          if (extAcct) {
            const { data: lateMatch } = await this.supabase
              .from('payment_orders')
              .select(
                'id, user_id, amount, amount_destination, exchange_rate_applied, currency, flow_type',
              )
              .eq('status', 'processing')
              .in('flow_type', ['bolivia_to_world'])
              .eq('external_account_id', extAcct.id)
              .is('bridge_drain_id', null)
              .order('created_at', { ascending: true })
              .limit(10);

            // Comparar contra monto bruto (amount / rate) para evitar doble cobro de fee
            const tolerance = 0.02;
            const matched = (lateMatch ?? []).find((o) => {
              const rate = parseFloat(o.exchange_rate_applied ?? '1');
              const grossAmount = parseFloat(o.amount ?? '0') / rate;
              return Math.abs(grossAmount - amount) <= tolerance;
            });

            if (matched) {
              // Vincular y completar en un solo paso
              await this.completeDrainOrder(
                matched,
                drainId,
                receipt,
                depositTxHash,
              );
              return;
            }
          }
        }

        // Match tardío por to_address (flujo bolivia_to_wallet)
        const destToAddress = destination?.to_address as string | undefined;
        if (destToAddress && amount > 0) {
          const { data: lateMatchByAddr } = await this.supabase
            .from('payment_orders')
            .select(
              'id, user_id, amount, amount_destination, exchange_rate_applied, currency, flow_type',
            )
            .eq('status', 'processing')
            .in('flow_type', ['bolivia_to_wallet'])
            .eq('destination_address', destToAddress)
            .is('bridge_drain_id', null)
            .order('created_at', { ascending: true })
            .limit(10);

          // Comparar contra monto bruto para evitar doble cobro de fee
          const addrTolerance = 0.02;
          const matchedByAddr = (lateMatchByAddr ?? []).find((o) => {
            const rate = parseFloat(o.exchange_rate_applied ?? '1');
            const grossAmount = parseFloat(o.amount ?? '0') / rate;
            return Math.abs(grossAmount - amount) <= addrTolerance;
          });

          if (matchedByAddr) {
            await this.completeDrainOrder(
              matchedByAddr,
              drainId,
              receipt,
              depositTxHash,
            );
            return;
          }
        }

        this.logger.warn(
          `❌ Drain ${drainId} (payment_processed) no pudo vincularse. Requiere intervención manual.`,
        );
        return;
      }

      // Orden encontrada por bridge_drain_id — completar
      await this.completeDrainOrder(order, drainId, receipt, depositTxHash);
    } else if (state === 'payment_submitted') {
      await this.handleDrainPaymentSubmitted(drainId);
    } else if (state === 'in_review') {
      await this.handleDrainInReview(drainId);
    } else if (state === 'undeliverable') {
      await this.handleDrainUndeliverable(drainId, eventObject);
    } else if (state === 'returned') {
      await this.handleDrainReturned(drainId, eventObject);
    } else if (state === 'canceled') {
      await this.handleDrainCanceled(drainId, eventObject);
    } else if (state === 'error') {
      await this.handleDrainError(drainId, eventObject);
    } else if (state === 'missing_return_policy') {
      await this.handleDrainMissingReturnPolicy(drainId);
    } else if (state === 'refund_in_flight') {
      await this.handleDrainRefundInFlight(drainId);
    } else if (state === 'refund_failed') {
      await this.handleDrainRefundFailed(drainId);
    } else if (state === 'refunded') {
      await this.handleDrainRefunded(drainId);
    } else {
      this.logger.warn(
        `⚠️ Drain ${drainId}: estado desconocido "${state}" — sin handler registrado.`,
      );
    }
  }

  /**
   * Completa un expediente bolivia_to_world vinculado a un drain de liquidation address.
   * Actualiza estado a completed, crea audit log y notifica al usuario.
   */
  private async completeDrainOrder(
    order: {
      id: string;
      user_id: string;
      amount: string;
      amount_destination: string;
      currency: string;
      flow_type: string;
    },
    drainId: string,
    receipt?: Record<string, unknown>,
    depositTxHash?: string | null,
  ): Promise<void> {
    // 1. Actualizar orden a completed
    await this.supabase
      .from('payment_orders')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        bridge_drain_id: drainId,
        ...(depositTxHash ? { source_tx_hash: depositTxHash } : {}),
        ...(receipt?.final_amount
          ? { amount_destination: parseFloat(receipt.final_amount as string) }
          : {}),
      })
      .eq('id', order.id);

    // WS: notificar al usuario y staff que la orden via drain fue completada
    this.ordersGateway.emitOrderUpdated(order.user_id, {
      id: order.id,
      user_id: order.user_id,
      status: 'completed',
      flow_type: order.flow_type,
      updated_at: new Date().toISOString(),
    });

    // 2. Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: null,
      action: 'COMPLETE_PAYMENT_ORDER_VIA_DRAIN',
      table_name: 'payment_orders',
      record_id: order.id,
      previous_values: { status: 'processing' },
      new_values: {
        status: 'completed',
        bridge_drain_id: drainId,
        receipt: receipt ?? null,
      },
      source: 'webhook',
    });

    // 3. Notificación al usuario
    const finalAmount =
      receipt?.final_amount ?? order.amount_destination ?? order.amount;
    await this.supabase.from('notifications').insert({
      user_id: order.user_id,
      type: 'financial',
      title: 'Transferencia Completada',
      message: `Tu orden de pago por $${finalAmount} ha sido completada exitosamente. Los fondos fueron enviados al destino.`,
      reference_type: 'payment_order',
      reference_id: order.id,
    });

    // 4. Activity log
    await this.supabase.from('activity_logs').insert({
      user_id: order.user_id,
      action: 'PAYMENT_ORDER_COMPLETED_VIA_DRAIN',
      description: `Orden ${order.id} (${order.flow_type}) completada vía webhook drain ${drainId}`,
    });

    // 5. Comprobante PSAV — generado automáticamente al completar (fire-and-forget)
    void this.paymentOrdersService.storePsavReceiptOnCompletion(order.id);

    this.logger.log(
      `✅ Orden ${order.id} completada vía drain ${drainId} (payment_processed)`,
    );
  }

  // ═══════════════════════════════════════════════
  //  HANDLERS: estados de drain de Bridge
  //  Gestiona todos los estados intermedios y de fallo
  //  que Bridge puede enviar vía webhook.
  // ═══════════════════════════════════════════════

  /**
   * Notifica a los administradores/staff activos del sistema.
   * Usado por handlers de fallo y estados críticos.
   */
  private async notifyAdminStaff(
    title: string,
    message: string,
    referenceId: string,
    notifType: 'system' | 'alert' = 'alert',
  ): Promise<void> {
    const { data: admins } = await this.supabase
      .from('profiles')
      .select('id')
      .in('role', ['staff', 'admin', 'super_admin'])
      .eq('is_active', true)
      .limit(5);

    if (admins?.length) {
      await this.supabase.from('notifications').insert(
        admins.map((a) => ({
          user_id: a.id,
          type: notifType,
          title,
          message,
          reference_type: 'payment_order',
          reference_id: referenceId,
        })),
      );
    }
  }

  /**
   * Busca la orden de pago vinculada a un drain por su bridge_drain_id.
   */
  private async findOrderByDrainId(drainId: string): Promise<{
    id: string;
    user_id: string;
    amount: string;
    amount_destination: string;
    currency: string;
    flow_type: string;
    status: string;
    failure_reason: string | null;
  } | null> {
    const { data } = await this.supabase
      .from('payment_orders')
      .select(
        'id, user_id, amount, amount_destination, currency, flow_type, status, failure_reason',
      )
      .eq('bridge_drain_id', drainId)
      .maybeSingle();
    return data ?? null;
  }

  /**
   * Marca una orden de pago como fallida a causa de un estado de drain de Bridge.
   * Actualiza status, failure_reason, emite WebSocket, y registra audit/activity logs.
   * Opcionalmente notifica al usuario final.
   */
  private async failDrainOrder(
    order: {
      id: string;
      user_id: string;
      flow_type: string;
      status: string;
    },
    drainId: string,
    bridgeState: string,
    failureReason: string,
    userMessage: string,
    notifyUser = true,
  ): Promise<void> {
    if (['completed', 'failed', 'cancelled'].includes(order.status)) {
      this.logger.warn(
        `⚠️ Drain ${drainId}: estado ${bridgeState} recibido para orden ${order.id} ya en estado terminal "${order.status}" — ignorado.`,
      );
      return;
    }

    await this.supabase
      .from('payment_orders')
      .update({
        status: 'failed',
        failure_reason: failureReason,
        bridge_drain_id: drainId,
      })
      .eq('id', order.id);

    this.ordersGateway.emitOrderUpdated(order.user_id, {
      id: order.id,
      user_id: order.user_id,
      status: 'failed',
      flow_type: order.flow_type,
      updated_at: new Date().toISOString(),
    });

    await this.supabase.from('audit_logs').insert({
      performed_by: null,
      action: `DRAIN_${bridgeState.toUpperCase().replace(/-/g, '_')}_ORDER_FAILED`,
      table_name: 'payment_orders',
      record_id: order.id,
      previous_values: { status: order.status },
      new_values: {
        status: 'failed',
        failure_reason: failureReason,
        bridge_drain_id: drainId,
      },
      source: 'webhook',
    });

    if (notifyUser) {
      await this.supabase.from('notifications').insert({
        user_id: order.user_id,
        type: 'alert',
        title: 'Transferencia No Completada',
        message: userMessage,
        reference_type: 'payment_order',
        reference_id: order.id,
      });
    }

    await this.supabase.from('activity_logs').insert({
      user_id: order.user_id,
      action: 'PAYMENT_ORDER_DRAIN_FAILED',
      description: `Orden ${order.id} fallida vía drain ${drainId} (Bridge state: ${bridgeState})`,
    });

    this.logger.warn(
      `❌ Orden ${order.id} marcada como fallida — drain ${drainId}, estado Bridge: ${bridgeState}`,
    );
  }

  // ── payment_submitted ──────────────────────────────────────────────────────

  /**
   * Bridge envió el pago ACH/wire al banco destino.
   * Estado intermedio — la orden permanece en 'processing'.
   * Notifica al usuario que los fondos están en camino.
   */
  private async handleDrainPaymentSubmitted(drainId: string): Promise<void> {
    this.logger.log(
      `📤 Drain ${drainId}: pago ACH/wire enviado, pendiente de confirmación final.`,
    );

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.warn(
        `⚠️ handleDrainPaymentSubmitted: no se encontró orden para drain ${drainId}`,
      );
      return;
    }

    await this.supabase.from('notifications').insert({
      user_id: order.user_id,
      type: 'financial',
      title: 'Transferencia en Camino',
      message:
        'Tu transferencia fue enviada al banco destino. La confirmación final puede demorar unos minutos dependiendo del banco.',
      reference_type: 'payment_order',
      reference_id: order.id,
    });
  }

  // ── in_review ──────────────────────────────────────────────────────────────

  /**
   * Bridge puso el drain en revisión de compliance/AML.
   * Suele resolverse automáticamente en segundos.
   * La orden permanece en 'processing' — solo se alerta al staff.
   */
  private async handleDrainInReview(drainId: string): Promise<void> {
    this.logger.warn(
      `🔍 Drain ${drainId}: en revisión de compliance por Bridge.`,
    );

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.warn(
        `⚠️ handleDrainInReview: no se encontró orden para drain ${drainId}`,
      );
      return;
    }

    await this.notifyAdminStaff(
      '🔍 Drain en Revisión Bridge',
      `Drain ${drainId} (Orden ${order.id}) en revisión de compliance. Normalmente resuelve en segundos de forma automática. Si supera 24 horas sin resolución, Bridge contactará al equipo técnico.`,
      order.id,
      'system',
    );
  }

  // ── undeliverable ──────────────────────────────────────────────────────────

  /**
   * Bridge no pudo enviar el pago — cuenta bancaria inválida.
   * El USDT quedó en Bridge; Bridge iniciará el reembolso automáticamente
   * si hay Crypto Return Policy configurada.
   */
  private async handleDrainUndeliverable(
    drainId: string,
    eventObject: Record<string, unknown>,
  ): Promise<void> {
    this.logger.warn(
      `❌ Drain ${drainId}: undeliverable — cuenta bancaria destino inválida.`,
    );

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.warn(
        `⚠️ handleDrainUndeliverable: no se encontró orden para drain ${drainId}`,
      );
      return;
    }

    const reason =
      (eventObject?.failure_reason as string) ??
      'routing/account inválido o tipo de activo no soportado';

    await this.failDrainOrder(
      order,
      drainId,
      'undeliverable',
      `bridge_undeliverable: ${reason}`,
      'Tu transferencia no pudo ser procesada porque la cuenta bancaria de destino no es válida. Por favor contacta a soporte para verificar y corregir los datos bancarios.',
    );

    await this.notifyAdminStaff(
      '⚠️ Drain UNDELIVERABLE',
      `Orden ${order.id} — Drain ${drainId}: cuenta bancaria destino inválida (${reason}). Verificar el external_account del cliente. Bridge iniciará reembolso de USDT automáticamente al return address de Guira.`,
      order.id,
    );
  }

  // ── returned ──────────────────────────────────────────────────────────────

  /**
   * Bridge envió el pago pero el banco destino lo rechazó y devolvió los fondos.
   * El USDT está de vuelta en Bridge; Bridge iniciará el reembolso automáticamente.
   */
  private async handleDrainReturned(
    drainId: string,
    eventObject: Record<string, unknown>,
  ): Promise<void> {
    this.logger.warn(
      `🔄 Drain ${drainId}: returned — el banco destino rechazó y devolvió el pago.`,
    );

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.warn(
        `⚠️ handleDrainReturned: no se encontró orden para drain ${drainId}`,
      );
      return;
    }

    const reason =
      (eventObject?.return_reason as string) ??
      (eventObject?.reason as string) ??
      'banco destino rechazó el pago';

    await this.failDrainOrder(
      order,
      drainId,
      'returned',
      `bridge_returned: ${reason}`,
      'Tu transferencia fue enviada pero fue devuelta por el banco destino. Esto puede ocurrir si la cuenta tiene restricciones o fue cerrada. Por favor contacta a soporte.',
    );

    await this.notifyAdminStaff(
      '⚠️ Drain RETURNED',
      `Orden ${order.id} — Drain ${drainId}: pago devuelto por banco destino (${reason}). Bridge devolverá el USDT automáticamente al return address de Guira.`,
      order.id,
    );
  }

  // ── canceled ──────────────────────────────────────────────────────────────

  /**
   * Bridge canceló el drain antes de enviarlo.
   * Causas: rechazo AML/EFE o monto debajo del threshold mínimo de la ruta.
   */
  private async handleDrainCanceled(
    drainId: string,
    eventObject: Record<string, unknown>,
  ): Promise<void> {
    this.logger.warn(`🚫 Drain ${drainId}: canceled.`);

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.warn(
        `⚠️ handleDrainCanceled: no se encontró orden para drain ${drainId}`,
      );
      return;
    }

    const reason =
      (eventObject?.cancellation_reason as string) ??
      (eventObject?.reason as string) ??
      'cancelado por compliance o monto debajo del mínimo de la ruta';

    await this.failDrainOrder(
      order,
      drainId,
      'canceled',
      `bridge_canceled: ${reason}`,
      'Tu transferencia fue cancelada. Esto puede ocurrir por restricciones de compliance o porque el monto no cumple los requisitos mínimos de la ruta. Por favor contacta a soporte.',
    );

    await this.notifyAdminStaff(
      '⚠️ Drain CANCELADO',
      `Orden ${order.id} — Drain ${drainId} cancelado. Motivo: ${reason}. Verificar si aplica restricción de compliance (AML/EFE) o threshold mínimo de ruta.`,
      order.id,
    );
  }

  // ── error ──────────────────────────────────────────────────────────────────

  /**
   * Error interno de Bridge — intervención manual requerida.
   * Bridge contactará al equipo técnico de Guira directamente.
   */
  private async handleDrainError(
    drainId: string,
    _eventObject: Record<string, unknown>,
  ): Promise<void> {
    this.logger.error(
      `🚨 Drain ${drainId}: error interno de Bridge — intervención manual requerida.`,
    );

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.error(
        `🚨 handleDrainError: no se encontró orden para drain ${drainId}. Contactar Bridge Support.`,
      );
      return;
    }

    await this.failDrainOrder(
      order,
      drainId,
      'error',
      'bridge_error: error interno de Bridge — intervención manual requerida',
      'Hubo un problema técnico con tu transferencia. Nuestro equipo ya fue notificado y está trabajando en resolverlo. Te contactaremos pronto.',
    );

    await this.notifyAdminStaff(
      '🚨 CRÍTICO — Error Bridge',
      `Orden ${order.id} — Drain ${drainId} en estado de ERROR en Bridge. Bridge contactará al equipo técnico. Revisar dashboard de Bridge urgentemente y contactar Bridge Support si no hay respuesta.`,
      order.id,
      'alert',
    );
  }

  // ── missing_return_policy ─────────────────────────────────────────────────

  /**
   * Bridge no puede devolver el USDT porque no hay Crypto Return Policy configurada.
   * Error crítico de configuración de plataforma — solo alerta al staff.
   * No notificar al usuario hasta resolver la configuración con Bridge.
   */
  private async handleDrainMissingReturnPolicy(drainId: string): Promise<void> {
    this.logger.error(
      `🚨 Drain ${drainId}: missing_return_policy — no hay Crypto Return Policy configurada en Bridge.`,
    );

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.error(
        `🚨 handleDrainMissingReturnPolicy: no se encontró orden para drain ${drainId}.`,
      );
      return;
    }

    if (!['completed', 'failed', 'cancelled'].includes(order.status)) {
      await this.supabase
        .from('payment_orders')
        .update({
          status: 'failed',
          failure_reason:
            'bridge_missing_return_policy: Bridge no puede devolver el USDT sin una Crypto Return Policy configurada',
          bridge_drain_id: drainId,
        })
        .eq('id', order.id);

      this.ordersGateway.emitOrderUpdated(order.user_id, {
        id: order.id,
        user_id: order.user_id,
        status: 'failed',
        flow_type: order.flow_type,
        updated_at: new Date().toISOString(),
      });

      await this.supabase.from('audit_logs').insert({
        performed_by: null,
        action: 'DRAIN_MISSING_RETURN_POLICY',
        table_name: 'payment_orders',
        record_id: order.id,
        previous_values: { status: order.status },
        new_values: {
          status: 'failed',
          failure_reason: 'bridge_missing_return_policy',
        },
        source: 'webhook',
      });
    }

    // Solo alerta al staff — NO notificar al usuario hasta resolver la config
    await this.notifyAdminStaff(
      '🚨 CRÍTICO — Missing Return Policy',
      `Drain ${drainId} (Orden ${order.id}): Bridge necesita devolver USDT pero NO existe una Crypto Return Policy configurada en la cuenta de Bridge de Guira. Configurar URGENTEMENTE en el dashboard de Bridge para que los fondos no queden retenidos indefinidamente.`,
      order.id,
      'alert',
    );
  }

  // ── refund_in_flight ──────────────────────────────────────────────────────

  /**
   * Bridge está enviando el USDT de vuelta on-chain al return address de Guira.
   * Estado informativo — solo notifica al staff.
   */
  private async handleDrainRefundInFlight(drainId: string): Promise<void> {
    this.logger.log(
      `🔄 Drain ${drainId}: reembolso de USDT en progreso (on-chain).`,
    );

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.warn(
        `⚠️ handleDrainRefundInFlight: no se encontró orden para drain ${drainId}`,
      );
      return;
    }

    await this.notifyAdminStaff(
      '🔄 Reembolso USDT en Progreso',
      `Drain ${drainId} (Orden ${order.id}): Bridge está enviando el USDT de vuelta on-chain al return address de Guira. Esperar confirmación final (estado "refunded").`,
      order.id,
      'system',
    );
  }

  // ── refund_failed ─────────────────────────────────────────────────────────

  /**
   * La transacción on-chain de reembolso del USDT falló.
   * Los fondos pueden estar retenidos en Bridge — contactar Bridge Support.
   */
  private async handleDrainRefundFailed(drainId: string): Promise<void> {
    this.logger.error(
      `🚨 Drain ${drainId}: refund_failed — la transacción on-chain de reembolso falló.`,
    );

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.error(
        `🚨 handleDrainRefundFailed: no se encontró orden para drain ${drainId}.`,
      );
      return;
    }

    await this.notifyAdminStaff(
      '🚨 CRÍTICO — Reembolso USDT Fallido',
      `Drain ${drainId} (Orden ${order.id}): la transacción on-chain de reembolso de USDT falló. Los fondos pueden estar retenidos en Bridge. Contactar Bridge Support inmediatamente.`,
      order.id,
      'alert',
    );
  }

  // ── refunded ──────────────────────────────────────────────────────────────

  /**
   * Bridge completó el reembolso — USDT llegó al return address de Guira.
   * Acción requerida: el staff debe procesar el reembolso en BOB al usuario vía PSAV.
   */
  private async handleDrainRefunded(drainId: string): Promise<void> {
    this.logger.log(
      `💰 Drain ${drainId}: USDT reembolsado exitosamente al return address de Guira.`,
    );

    const order = await this.findOrderByDrainId(drainId);
    if (!order) {
      this.logger.warn(
        `⚠️ handleDrainRefunded: no se encontró orden para drain ${drainId}`,
      );
      return;
    }

    // Actualizar failure_reason para registrar que el USDT ya fue devuelto a Guira
    const currentReason = order.failure_reason ?? 'bridge_refunded';
    await this.supabase
      .from('payment_orders')
      .update({
        failure_reason: `${currentReason} | USDT devuelto al return address de Guira — pendiente reembolso BOB al usuario`,
      })
      .eq('id', order.id);

    // Alerta al staff: acción manual requerida — devolver BOB al usuario vía PSAV
    await this.notifyAdminStaff(
      '💰 USDT Devuelto — Acción Requerida',
      `Drain ${drainId} (Orden ${order.id}): el USDT fue devuelto exitosamente al return address de Guira. ACCIÓN REQUERIDA: procesar reembolso en BOB al usuario ${order.user_id} vía PSAV. Monto original: ${order.amount} ${order.currency}.`,
      order.id,
      'alert',
    );

    // Notificar al usuario que su reembolso está siendo procesado
    await this.supabase.from('notifications').insert({
      user_id: order.user_id,
      type: 'financial',
      title: 'Reembolso en Proceso',
      message:
        'Tu transferencia no pudo completarse, pero los fondos han sido recuperados. Nuestro equipo procesará tu reembolso en los próximos días hábiles. Te contactaremos para confirmar los detalles.',
      reference_type: 'payment_order',
      reference_id: order.id,
    });

    await this.supabase.from('activity_logs').insert({
      user_id: order.user_id,
      action: 'PAYMENT_ORDER_DRAIN_REFUNDED',
      description: `Drain ${drainId}: USDT devuelto a Guira. Orden ${order.id} pendiente de reembolso BOB manual vía PSAV.`,
    });
  }

  // ═══════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════

  // ═══════════════════════════════════════════════
  //  HELPER: Extraer issues/razones de rechazo de Bridge
  // ═══════════════════════════════════════════════

  /**
   * Extrae razones de rechazo del payload de Bridge.
   * Bridge puede enviar issues en múltiples formatos dependiendo del evento:
   *  - event_object.issues[] (array de strings)
   *  - event_object.rejection_reasons[] (array de strings)
   *  - event_object.status_reason (string)
   *  - event_object.active_regulation_checks[].status (object array)
   */
  private extractBridgeIssues(
    eventObject: Record<string, unknown> | undefined,
  ): string[] {
    if (!eventObject) return ['unknown_reason'];

    const issues: string[] = [];

    // Formato 1: issues[] (más común en customer.updated)
    if (Array.isArray(eventObject.issues)) {
      for (const issue of eventObject.issues) {
        if (typeof issue === 'string') {
          issues.push(issue);
        } else if (typeof issue === 'object' && issue !== null) {
          // Pueden ser objetos con type/message
          const issueObj = issue as Record<string, unknown>;
          const msg = (issueObj.message ??
            issueObj.type ??
            issueObj.code ??
            JSON.stringify(issue)) as string;
          issues.push(msg);
        }
      }
    }

    // Formato 2: rejection_reasons[]
    if (Array.isArray(eventObject.rejection_reasons)) {
      for (const reason of eventObject.rejection_reasons) {
        if (typeof reason === 'string') issues.push(reason);
      }
    }

    // Formato 3: status_reason (string simple)
    if (
      typeof eventObject.status_reason === 'string' &&
      eventObject.status_reason
    ) {
      issues.push(eventObject.status_reason);
    }

    // Formato 4: active_regulation_checks con status != 'approved'
    if (Array.isArray(eventObject.active_regulation_checks)) {
      for (const check of eventObject.active_regulation_checks) {
        const checkObj = check as Record<string, unknown>;
        if (
          checkObj.status &&
          checkObj.status !== 'approved' &&
          checkObj.status !== 'passed'
        ) {
          issues.push(`${checkObj.type ?? 'check'}: ${checkObj.status}`);
        }
      }
    }

    // Formato 5: endorsements[*].requirements.issues[]
    // Bridge coloca las razones de rechazo (ej. duplicate_customer_detected)
    // dentro de cada endorsement, no en el top-level del event_object.
    if (Array.isArray(eventObject.endorsements)) {
      for (const endorsement of eventObject.endorsements) {
        const endObj = endorsement as Record<string, unknown>;
        const requirements = endObj.requirements as
          | Record<string, unknown>
          | undefined;
        if (requirements && Array.isArray(requirements.issues)) {
          for (const issue of requirements.issues) {
            if (typeof issue === 'string' && !issues.includes(issue)) {
              issues.push(issue);
            } else if (typeof issue === 'object' && issue !== null) {
              const issueObj = issue as Record<string, unknown>;
              const msg = (issueObj.message ??
                issueObj.type ??
                issueObj.code ??
                JSON.stringify(issue)) as string;
              if (!issues.includes(msg)) issues.push(msg);
            }
          }
        }
      }
    }

    return issues.length > 0 ? issues : ['rejected_by_bridge'];
  }

  /**
   * Verificación de la firma Bridge usando RSA-SHA256.
   *
   * Formato del header X-Webhook-Signature:
   *   t=<unix_timestamp>,v0=<base64_encoded_signature>
   *
   * Algoritmo de verificación (Bridge docs):
   *   1. Extraer timestamp (t) y firma base64 (v0) del header
   *   2. Rechazar si el evento tiene más de 10 minutos (anti-replay)
   *   3. Construir el mensaje: `<timestamp>.<rawBody>`
   *   4. Generar digest SHA256 del mensaje
   *   5. Verificar la firma RSA con la public_key del webhook
   *
   * @param rawBody - Buffer con el body exactamente como llegó de Bridge
   * @param signatureHeader - Valor del header X-Webhook-Signature
   */
  private verifyBridgeSignature(
    rawBody: Buffer,
    signatureHeader: string | null,
  ): boolean {
    const publicKey = this.config.get<string>('app.bridgeWebhookPublicKey');
    if (!publicKey || !signatureHeader) return false;

    try {
      // Parsear el header: t=<timestamp>,v0=<base64sig>
      const parts = Object.fromEntries(
        signatureHeader.split(',').map((part) => {
          const [k, ...v] = part.split('=');
          return [k.trim(), v.join('=').trim()];
        }),
      );

      const timestamp = parts['t'];
      const signatureB64 = parts['v0'];

      if (!timestamp || !signatureB64) {
        this.logger.warn('Firma Bridge malformada: faltan campos t o v0');
        return false;
      }

      // Anti-replay: rechazar eventos de más de 10 minutos
      const eventAge = Date.now() / 1000 - parseInt(timestamp, 10);
      if (eventAge > 600) {
        this.logger.warn(
          `Evento Bridge demasiado antiguo (${Math.round(eventAge)}s) — posible replay attack`,
        );
        return false;
      }

      // Construir el mensaje que Bridge firmó: "<timestamp>.<rawBody>"
      const message = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);

      // Generar digest SHA256 del mensaje
      const digest = crypto.createHash('sha256').update(message).digest();

      // Verificar firma RSA con la public_key del webhook
      const signatureBuf = Buffer.from(signatureB64, 'base64');
      const normalizedKey = publicKey.replace(/\\n/g, '\n');

      const result = crypto.verify(
        'RSA-SHA256',
        digest,
        { key: normalizedKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        signatureBuf,
      );

      return result;
    } catch (e) {
      this.logger.error(`Error verificando firma Bridge: ${e}`);
      return false;
    }
  }

  /**
   * Inicializa wallets de un cliente recién aprobado.
   *
   * REFACTORIZADO: Delega a WalletsService.initializeClientWallets() para
   * centralizar toda la lógica de creación de wallets en un solo lugar.
   * Esto asegura que tanto el webhook como el endpoint admin usen
   * la misma lógica, incluyendo soporte multi-token.
   */
  private async initializeWalletsForUser(
    userId: string,
    bridgeCustomerId: string | null,
  ): Promise<void> {
    try {
      await this.walletsService.initializeClientWallets(
        userId,
        bridgeCustomerId ?? undefined,
      );
      this.logger.log(
        `Wallets inicializadas para user ${userId} via webhook (delegado a WalletsService)`,
      );
    } catch (err) {
      this.logger.error(`Error inicializando wallets para ${userId}: ${err}`);
    }
  }

  private async notifyAdminWebhookFailed(
    webhookId: string,
    eventType: string,
    error: string,
  ): Promise<void> {
    // Buscar admin users
    const { data: admins } = await this.supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'super_admin'])
      .eq('is_active', true)
      .limit(5);

    if (!admins?.length) return;

    const notifications = admins.map((admin) => ({
      user_id: admin.id,
      type: 'system',
      title: '⚠️ Webhook Fallido (5 reintentos)',
      message: `Evento ${eventType} (${webhookId}) falló 5 veces: ${error.slice(0, 200)}`,
      reference_type: 'webhook_event',
      reference_id: webhookId,
    }));

    await this.supabase.from('notifications').insert(notifications);
  }
}

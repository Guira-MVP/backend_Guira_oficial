import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/dto/notifications.dto';

export interface CreateReviewRequestPayload {
  userId: string;
  flowType: string;
  amount: number;
  currency: string;
  amountUsdEquiv: number;
  limitUsd: number;
  excessUsd: number;
  requestPayload: Record<string, unknown>;
  clientReason: string;
  documentUrl?: string;
}

export interface ApproveReviewPayload {
  staffNotes?: string;
}

export interface RejectReviewPayload {
  staffNotes: string;
}

export interface OrderReviewRequest {
  id: string;
  user_id: string;
  flow_type: string;
  amount: number;
  currency: string;
  amount_usd_equiv: number;
  limit_usd: number;
  excess_usd: number;
  request_payload: Record<string, unknown>;
  client_reason: string;
  document_url: string | null;
  status: 'pending_review' | 'approved' | 'rejected' | 'expired' | 'cancelled_by_user';
  reviewed_by: string | null;
  reviewed_at: string | null;
  staff_notes: string | null;
  payment_order_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class OrderReviewService {
  private readonly logger = new Logger(OrderReviewService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly notificationsService: NotificationsService,
  ) {}

  // ── Cron: marcar expiradas cada hora ──────────────────────────

  @Cron(CronExpression.EVERY_HOUR)
  async expireStaleRequests(): Promise<void> {
    const { data, error } = await this.supabase
      .from('order_review_requests')
      .update({ status: 'expired' })
      .eq('status', 'pending_review')
      .lt('expires_at', new Date().toISOString())
      .select('id');

    if (error) {
      this.logger.error(`Error expirando solicitudes: ${error.message}`);
      return;
    }

    if (data && data.length > 0) {
      this.logger.log(`⏰ ${data.length} solicitudes de revisión expiradas automáticamente`);

      const auditRows = data.map((row: { id: string }) => ({
        performed_by: null,
        action: 'EXPIRE_REVIEW_REQUEST',
        table_name: 'order_review_requests',
        new_values: { id: row.id, status: 'expired' },
        source: 'cron',
      }));
      const { error: auditError } = await this.supabase.from('audit_logs').insert(auditRows);
      if (auditError) {
        this.logger.error(`Error registrando expiración en audit_logs: ${auditError.message}`);
      }
    }
  }

  // ── Crear solicitud ───────────────────────────────────────────

  async createReviewRequest(payload: CreateReviewRequestPayload): Promise<OrderReviewRequest> {
    // Verificar que no haya otra solicitud activa para el mismo usuario + flow_type
    const { data: existing } = await this.supabase
      .from('order_review_requests')
      .select('id')
      .eq('user_id', payload.userId)
      .eq('flow_type', payload.flowType)
      .eq('status', 'pending_review')
      .maybeSingle();

    if (existing) {
      throw new ConflictException({
        message: 'Ya tienes una solicitud de revisión pendiente para este servicio',
        review_id: existing.id,
      });
    }

    // Leer tiempo de expiración desde app_settings
    const { data: setting } = await this.supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'ORDER_REVIEW_EXPIRY_HOURS')
      .single();

    const parsedHours = parseInt(setting?.value ?? '48', 10);
    const expiryHours = isNaN(parsedHours) || parsedHours <= 0 ? 48 : parsedHours;
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();

    const { data, error } = await this.supabase
      .from('order_review_requests')
      .insert({
        user_id: payload.userId,
        flow_type: payload.flowType,
        amount: payload.amount,
        currency: payload.currency,
        amount_usd_equiv: payload.amountUsdEquiv,
        limit_usd: payload.limitUsd,
        excess_usd: payload.excessUsd,
        request_payload: payload.requestPayload,
        client_reason: payload.clientReason,
        document_url: payload.documentUrl ?? null,
        status: 'pending_review',
        expires_at: expiresAt,
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase.from('audit_logs').insert({
      performed_by: payload.userId,
      action: 'CREATE_REVIEW_REQUEST',
      table_name: 'order_review_requests',
      new_values: {
        id: data.id,
        flow_type: payload.flowType,
        amount: payload.amount,
        currency: payload.currency,
        amount_usd_equiv: payload.amountUsdEquiv,
        limit_usd: payload.limitUsd,
      },
      source: 'client',
    });

    this.logger.log(`📋 Review request creada: ${data.id} — ${payload.flowType} $${payload.amount} ${payload.currency} (excede $${payload.limitUsd} USD)`);
    return data as OrderReviewRequest;
  }

  // ── Consultas cliente ─────────────────────────────────────────

  async getMyReviews(userId: string): Promise<OrderReviewRequest[]> {
    const { data, error } = await this.supabase
      .from('order_review_requests')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []) as OrderReviewRequest[];
  }

  async getMyReview(userId: string, reviewId: string): Promise<OrderReviewRequest> {
    const { data, error } = await this.supabase
      .from('order_review_requests')
      .select('*')
      .eq('id', reviewId)
      .eq('user_id', userId)
      .single();

    if (error || !data) throw new NotFoundException('Solicitud de revisión no encontrada');
    return data as OrderReviewRequest;
  }

  async cancelReview(userId: string, reviewId: string): Promise<void> {
    const { data: review, error: fetchErr } = await this.supabase
      .from('order_review_requests')
      .select('id, status, user_id')
      .eq('id', reviewId)
      .eq('user_id', userId)
      .single();

    if (fetchErr || !review) throw new NotFoundException('Solicitud de revisión no encontrada');
    if (review.status !== 'pending_review') {
      throw new BadRequestException('Solo se pueden cancelar solicitudes en estado pendiente');
    }

    const { error } = await this.supabase
      .from('order_review_requests')
      .update({ status: 'cancelled_by_user' })
      .eq('id', reviewId);

    if (error) throw new BadRequestException(error.message);

    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      action: 'CANCEL_REVIEW_REQUEST',
      table_name: 'order_review_requests',
      new_values: { id: reviewId, status: 'cancelled_by_user' },
      source: 'client',
    });
  }

  // ── Consultas admin / staff ───────────────────────────────────

  async listReviews(filters: {
    status?: string;
    flow_type?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: OrderReviewRequest[]; total: number }> {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = this.supabase
      .from('order_review_requests')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.flow_type) query = query.eq('flow_type', filters.flow_type);

    const { data, error, count } = await query;

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as unknown as OrderReviewRequest[];

    // Enrich with profile data (separate query — FK points to auth.users, not profiles)
    const userIds = [...new Set(rows.map((r) => r.user_id))];
    if (userIds.length > 0) {
      const { data: profiles } = await this.supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', userIds);
      const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      rows.forEach((r: any) => { r.profiles = profileMap.get(r.user_id) ?? null; });
    }

    return { data: rows, total: count ?? 0 };
  }

  async getReviewById(reviewId: string): Promise<OrderReviewRequest> {
    const { data, error } = await this.supabase
      .from('order_review_requests')
      .select('*')
      .eq('id', reviewId)
      .single();

    if (error || !data) throw new NotFoundException('Solicitud de revisión no encontrada');

    const row = data as any;
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', row.user_id)
      .single();
    row.profiles = profile ?? null;

    return row as unknown as OrderReviewRequest;
  }

  // ── Aprobar (staff) ───────────────────────────────────────────
  // Retorna el payload serializado para que el caller (PaymentOrdersService) cree la orden.

  async approveReview(
    reviewId: string,
    actorId: string,
    staffNotes?: string,
  ): Promise<{ review: OrderReviewRequest; payload: Record<string, unknown> }> {
    // Lock optimista: solo actualiza si sigue en pending_review
    const { data: updated, error } = await this.supabase
      .from('order_review_requests')
      .update({
        status: 'approved',
        reviewed_by: actorId,
        reviewed_at: new Date().toISOString(),
        staff_notes: staffNotes ?? null,
      })
      .eq('id', reviewId)
      .eq('status', 'pending_review')
      .select()
      .single();

    if (error || !updated) {
      throw new ConflictException(
        'No se pudo aprobar: la solicitud ya fue procesada por otro staff o no existe',
      );
    }

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      action: 'APPROVE_REVIEW_REQUEST',
      table_name: 'order_review_requests',
      new_values: { id: reviewId, status: 'approved', staff_notes: staffNotes },
      source: 'admin_panel',
    });

    this.logger.log(`✅ Review request ${reviewId} aprobada por ${actorId}`);
    return { review: updated as OrderReviewRequest, payload: updated.request_payload as Record<string, unknown> };
  }

  // Vincula el payment_order_id generado tras aprobar
  async linkPaymentOrder(reviewId: string, paymentOrderId: string): Promise<void> {
    const { error } = await this.supabase
      .from('order_review_requests')
      .update({ payment_order_id: paymentOrderId })
      .eq('id', reviewId);

    if (error) {
      throw new BadRequestException(`Error vinculando expediente a la revisión: ${error.message}`);
    }
  }

  // ── Rechazar (staff) ──────────────────────────────────────────

  async rejectReview(
    reviewId: string,
    actorId: string,
    staffNotes: string,
  ): Promise<OrderReviewRequest> {
    const { data: updated, error } = await this.supabase
      .from('order_review_requests')
      .update({
        status: 'rejected',
        reviewed_by: actorId,
        reviewed_at: new Date().toISOString(),
        staff_notes: staffNotes,
      })
      .eq('id', reviewId)
      .eq('status', 'pending_review')
      .select()
      .single();

    if (error || !updated) {
      throw new ConflictException(
        'No se pudo rechazar: la solicitud ya fue procesada o no existe',
      );
    }

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      action: 'REJECT_REVIEW_REQUEST',
      table_name: 'order_review_requests',
      new_values: { id: reviewId, status: 'rejected', staff_notes: staffNotes },
      source: 'admin_panel',
    });

    try {
      await this.notificationsService.sendNotification({
        userId: updated.user_id,
        type: NotificationType.FINANCIAL,
        title: 'Expediente rechazado',
        message: `Tu solicitud de ${updated.flow_type.replace(/_/g, ' ')} por ${updated.amount} ${updated.currency} fue rechazada. Motivo: ${staffNotes}`,
        link: '/panel/pagos',
        referenceType: 'order_review_request',
        referenceId: reviewId,
      });
    } catch (notifErr) {
      this.logger.error(`Error notificando rechazo al cliente (review ${reviewId}): ${(notifErr as Error)?.message}`);
    }

    this.logger.log(`❌ Review request ${reviewId} rechazada por ${actorId}`);
    return updated as OrderReviewRequest;
  }
}

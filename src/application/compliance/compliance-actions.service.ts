import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { BridgeService } from '../bridge/bridge.service';
import { BridgeCustomerService } from '../onboarding/bridge-customer.service';
import { SetLimitsDto } from './dto/admin-compliance.dto';

@Injectable()
export class ComplianceActionsService {
  private readonly logger = new Logger(ComplianceActionsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly bridgeService: BridgeService,
    private readonly bridgeCustomerService: BridgeCustomerService,
  ) {}

  // ── REVIEWS (Lectura) ─────────────────────────────────────────────

  async listOpenReviews(filters: Record<string, string>) {
    let query = this.supabase
      .from('compliance_reviews')
      .select('*')
      .eq('status', 'open')
      .order('priority', { ascending: false })
      .order('opened_at', { ascending: true });

    if (filters.priority) query = query.eq('priority', filters.priority);
    if (filters.assigned_to)
      query = query.eq('assigned_to', filters.assigned_to);

    const { data, error } = await query;
    if (error) throw new BadRequestException(error.message);
    if (!data || data.length === 0) return [];

    const enrichedData = await Promise.all(
      data.map(async (review) => {
        let userId: string | null = null;

        try {
          if (review.subject_type === 'kyc_applications') {
            const { data: kyc } = await this.supabase
              .from('kyc_applications')
              .select('user_id')
              .eq('id', review.subject_id)
              .single();
            userId = kyc?.user_id || null;
          } else if (review.subject_type === 'kyb_applications') {
            const { data: kyb } = await this.supabase
              .from('kyb_applications')
              .select('requester_user_id')
              .eq('id', review.subject_id)
              .single();
            userId = kyb?.requester_user_id || null;
          } else if (review.subject_type === 'payout_request') {
            const { data: pay } = await this.supabase
              .from('payout_requests')
              .select('user_id')
              .eq('id', review.subject_id)
              .single();
            userId = pay?.user_id || null;
          }
        } catch (err) {
          // Ignore relations error if subject was deleted
        }

        let profileData: Record<string, any> | null = null;
        if (userId) {
          const { data: prof } = await this.supabase
            .from('profiles')
            .select('email, full_name, role')
            .eq('id', userId)
            .maybeSingle();
          if (prof) {
            let businessName = null;
            if (review.subject_type === 'kyb_applications') {
              const { data: biz } = await this.supabase
                .from('businesses')
                .select('legal_name')
                .eq('user_id', userId)
                .maybeSingle();
              businessName = biz?.legal_name;
            }

            let firstName = '';
            let lastName = '';
            if (prof.full_name) {
              const parts = prof.full_name.split(' ');
              firstName = parts[0] || '';
              lastName = parts.slice(1).join(' ') || '';
            }

            profileData = {
              email: prof.email,
              first_name: firstName,
              last_name: lastName,
              full_name: prof.full_name,
              business_name: businessName || '',
            };
          }
        }

        // Determinar status de la aplicación si es necesario para el UI
        let appStatus = review.status; // fallback a review status ('open')
        let appUpdatedAt = review.opened_at;
        try {
          if (review.subject_type === 'kyc_applications') {
            const { data: kyc } = await this.supabase
              .from('kyc_applications')
              .select('status, updated_at')
              .eq('id', review.subject_id)
              .single();
            if (kyc) {
              appStatus = kyc.status;
              appUpdatedAt = kyc.updated_at;
            }
          } else if (review.subject_type === 'kyb_applications') {
            const { data: kyb } = await this.supabase
              .from('kyb_applications')
              .select('status, updated_at')
              .eq('id', review.subject_id)
              .single();
            if (kyb) {
              appStatus = kyb.status;
              appUpdatedAt = kyb.updated_at;
            }
          }
        } catch (e) {}

        return {
          ...review,
          user_id: userId,
          type:
            review.subject_type === 'kyb_applications' ? 'company' : 'personal',
          application_status: appStatus,
          updated_at: appUpdatedAt,
          profiles: profileData,
        };
      }),
    );

    return enrichedData;
  }

  async getReviewDetail(reviewId: string) {
    const { data: review, error } = await this.supabase
      .from('compliance_reviews')
      .select('*')
      .eq('id', reviewId)
      .single();

    if (error || !review) throw new NotFoundException('Review no encontrado');

    const { data: events } = await this.supabase
      .from('compliance_review_events')
      .select('*')
      .eq('review_id', reviewId)
      .order('created_at', { ascending: false });

    const { data: comments } = await this.supabase
      .from('compliance_review_comments')
      .select('*')
      .eq('review_id', reviewId)
      .order('created_at', { ascending: true });

    // C3 FIX: Resolver application data, profile y documents
    // para que el frontend no necesite queries directas a Supabase.
    let userId: string | null = null;
    let applicationData: Record<string, any> = {};
    let previousData: Record<string, any> | null = null;
    let onboardingType: 'personal' | 'company' = 'personal';

    if (review.subject_type === 'kyc_applications') {
      const { data: kyc } = await this.supabase
        .from('kyc_applications')
        .select('*, people (*)')
        .eq('id', review.subject_id)
        .maybeSingle();
      if (kyc) {
        userId = kyc.user_id;
        applicationData = this.mapKycToFormData(kyc);
        previousData = kyc.previous_data ?? null;
        onboardingType = 'personal';
      }
    } else if (review.subject_type === 'kyb_applications') {
      const { data: kyb } = await this.supabase
        .from('kyb_applications')
        .select('*, businesses (*, business_directors(*), business_ubos(*))')
        .eq('id', review.subject_id)
        .maybeSingle();
      if (kyb) {
        userId = kyb.requester_user_id;
        applicationData = kyb.businesses ?? kyb;
        previousData = kyb.previous_data ?? null;
        onboardingType = 'company';
      }
    }

    let profileData: any = null;
    let documents: any[] = [];

    if (userId) {
      const { data: prof } = await this.supabase
        .from('profiles')
        .select('id, email, full_name, onboarding_status, bridge_customer_id')
        .eq('id', userId)
        .maybeSingle();
      profileData = prof;

      // Documents con signed URLs — generadas server-side
      const { data: docs } = await this.supabase
        .from('documents')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      // Filtrar solo el más reciente por tipo
      const latestDocsMap = new Map<string, any>();
      for (const doc of docs ?? []) {
        const typeKey =
          doc.document_type || doc.description || 'unknown_document';
        if (!latestDocsMap.has(typeKey)) latestDocsMap.set(typeKey, doc);
      }

      documents = await Promise.all(
        Array.from(latestDocsMap.values()).map(async (doc) => {
          let signedUrl: string | null = null;
          if (doc.storage_path) {
            const { data: urlData } = await this.supabase.storage
              .from('kyc-documents')
              .createSignedUrl(doc.storage_path, 3600);
            signedUrl = urlData?.signedUrl ?? null;
          }
          return { ...doc, signed_url: signedUrl };
        }),
      );
    }

    return {
      ...review,
      events,
      comments,
      user_id: userId,
      onboarding_type: onboardingType,
      application_data: applicationData,
      previous_data: previousData,
      profile: profileData,
      documents,
    };
  }

  /**
   * Mapea los datos crudos de kyc_applications + people a un formato
   * plano esperado por el componente de detalle del frontend.
   */
  private mapKycToFormData(kyc: any): Record<string, any> {
    const p = kyc.people;
    if (!p) return kyc;
    return {
      first_names: p.first_name,
      last_names: p.last_name,
      middle_name: p.middle_name,
      dob: p.date_of_birth,
      nationality: p.nationality,
      id_document_type: p.id_type,
      id_number: p.id_number,
      id_expiry: p.id_expiry_date,
      tax_id: p.tax_id,
      email: p.email,
      phone: p.phone,
      street: p.address1,
      street2: p.address2,
      city: p.city,
      state_province: p.state,
      postal_code: p.postal_code,
      country: p.country,
      country_of_residence: p.country_of_residence,
      occupation: p.most_recent_occupation ?? p.employment_status,
      source_of_funds: p.source_of_funds,
      purpose: p.account_purpose,
      purpose_other: p.account_purpose_other,
      estimated_monthly_volume: p.expected_monthly_payments_usd,
      is_pep: p.is_pep,
      employment_status: p.employment_status,
    };
  }

  // ── REVIEWS (Acciones) ────────────────────────────────────────────

  async assignReview(reviewId: string, staffUserId: string, actorId: string, actorRole: string) {
    await this.supabase
      .from('compliance_reviews')
      .update({ assigned_to: staffUserId })
      .eq('id', reviewId);

    // Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: 'ASSIGN_COMPLIANCE_REVIEW',
      table_name: 'compliance_reviews',
      record_id: reviewId,
      new_values: { assigned_to: staffUserId },
      source: 'admin_panel',
    });

    return { message: 'Review asignado' };
  }

  async escalateReview(reviewId: string, actorId: string, actorRole: string) {
    await this.supabase
      .from('compliance_reviews')
      .update({ priority: 'urgent' })
      .eq('id', reviewId);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: 'ESCALATE_COMPLIANCE_REVIEW',
      table_name: 'compliance_reviews',
      record_id: reviewId,
      new_values: { priority: 'urgent' },
      source: 'admin_panel',
    });

    return { message: 'Review escalado a urgente' };
  }

  // ── COMMENTS ──────────────────────────────────────────────────────

  async addComment(
    reviewId: string,
    authorId: string,
    body: string,
    isInternal = true,
  ) {
    const { data, error } = await this.supabase
      .from('compliance_review_comments')
      .insert({
        review_id: reviewId,
        author_id: authorId,
        body,
        is_internal: isInternal,
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  // ── DECISIONS (Inmutables) ────────────────────────────────────────

  /**
   * Staff valida los datos y envía al proveedor Bridge para verificación KYC/KYB.
   * NO aprueba la cuenta directamente — la aprobación final viene del webhook de Bridge.
   * El review permanece ABIERTO hasta recibir respuesta de Bridge.
   */
  async approveReview(reviewId: string, actorId: string, reason: string, actorRole: string) {
    const { data: review } = await this.supabase
      .from('compliance_reviews')
      .select('subject_type, subject_id, status')
      .eq('id', reviewId)
      .single();

    if (!review) throw new NotFoundException('Review no encontrado');
    if (review.status === 'closed')
      throw new BadRequestException('El review ya está cerrado');

    // 1. Inmutable Event — registrar que el staff validó y envió a Bridge
    await this.supabase.from('compliance_review_events').insert({
      review_id: reviewId,
      actor_id: actorId,
      decision: 'SENT_TO_BRIDGE',
      reason,
    });

    // 2. Review permanece ABIERTO — se cerrará cuando Bridge responda vía webhook
    // No cerramos el review aquí.

    // 3. Enviar a Bridge (pone estados intermedios, NO aprueba)
    await this.sendToBridgeSubject(
      review.subject_type,
      review.subject_id,
      actorId,
      reason,
    );

    // 4. Audit Log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: 'SENT_TO_BRIDGE',
      table_name: 'compliance_reviews',
      record_id: reviewId,
      reason,
      source: 'admin_panel',
    });

    return {
      message:
        'Expediente enviado a Bridge para verificación. La aprobación final depende de la respuesta de Bridge.',
    };
  }

  /**
   * Re-envía los datos del cliente a Bridge via PUT cuando el estado quedó atascado en pending_bridge.
   * Requiere que el cliente ya tenga bridge_customer_id asignado.
   */
  async resendToBridge(reviewId: string, actorId: string): Promise<{ message: string }> {
    const { data: review } = await this.supabase
      .from('compliance_reviews')
      .select('subject_type, subject_id, status')
      .eq('id', reviewId)
      .single();

    if (!review) throw new NotFoundException('Review no encontrado');

    let userId: string | null = null;

    if (review.subject_type === 'kyc_applications') {
      const { data: kyc } = await this.supabase
        .from('kyc_applications')
        .select('user_id')
        .eq('id', review.subject_id)
        .single();
      userId = kyc?.user_id ?? null;
    } else if (review.subject_type === 'kyb_applications') {
      const { data: kyb } = await this.supabase
        .from('kyb_applications')
        .select('requester_user_id')
        .eq('id', review.subject_id)
        .single();
      userId = kyb?.requester_user_id ?? null;
    }

    if (!userId) throw new NotFoundException('No se encontró el usuario del expediente');

    const { data: profile } = await this.supabase
      .from('profiles')
      .select('bridge_customer_id')
      .eq('id', userId)
      .single();

    if (!profile?.bridge_customer_id) {
      throw new BadRequestException(
        'El cliente no tiene bridge_customer_id. Use "Aprobar" para el primer envío.',
      );
    }

    await this.bridgeCustomerService.updateCustomerInBridge(userId, profile.bridge_customer_id);

    if (review.subject_type === 'kyc_applications') {
      await this.supabase
        .from('kyc_applications')
        .update({ status: 'sent_to_bridge' })
        .eq('id', review.subject_id);
    } else if (review.subject_type === 'kyb_applications') {
      await this.supabase
        .from('kyb_applications')
        .update({ status: 'sent_to_bridge' })
        .eq('id', review.subject_id);
    }

    await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'pending_bridge' })
      .eq('id', userId);

    await this.supabase.from('compliance_review_events').insert({
      review_id: reviewId,
      actor_id: actorId,
      decision: 'RESENT_TO_BRIDGE',
      reason: 'Re-envío manual a Bridge por staff',
    });

    return { message: 'Datos re-enviados a Bridge correctamente.' };
  }

  // ── BRIDGE WEBHOOK CALLBACKS ──────────────────────────────────────

  /**
   * Llamado por el webhook handler cuando Bridge aprueba la cuenta (status = 'active').
   * ESTE es el único punto que marca la cuenta como 'approved' y habilita servicios.
   */
  async handleBridgeApproval(
    userId: string,
    bridgeCustomerId: string,
  ): Promise<void> {
    this.logger.log(
      `Bridge aprobó cuenta para user ${userId} (customer ${bridgeCustomerId})`,
    );

    // 1. Buscar review abierto para este usuario
    const review = await this.findOpenReviewForUser(userId);

    if (review) {
      // Registrar evento inmutable de aprobación por Bridge
      await this.supabase.from('compliance_review_events').insert({
        review_id: review.id,
        actor_id: userId,
        decision: 'BRIDGE_APPROVED',
        reason: `Bridge confirmó verificación KYC/KYB — customer: ${bridgeCustomerId}`,
      });

      // Cerrar review
      await this.supabase
        .from('compliance_reviews')
        .update({ status: 'closed', closed_at: new Date().toISOString() })
        .eq('id', review.id);
    }

    // 2. Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'system',
      action: 'BRIDGE_APPROVED',
      table_name: 'profiles',
      record_id: userId,
      reason: `Bridge webhook confirmó aprobación — customer: ${bridgeCustomerId}`,
      source: 'webhook',
    });
  }

  /**
   * Llamado por el webhook handler cuando Bridge rechaza la cuenta.
   * Marca estados como 'bridge_rejected', notifica staff y cliente.
   */
  async handleBridgeRejection(
    userId: string,
    bridgeCustomerId: string,
    issues: string[],
  ): Promise<void> {
    this.logger.warn(
      `Bridge rechazó cuenta para user ${userId} — issues: ${issues.join(', ')}`,
    );

    // 1. Idempotency Check & Profile Data
    const { data: profile } = await this.supabase
      .from('profiles')
      .select('onboarding_status, full_name, email')
      .eq('id', userId)
      .maybeSingle();

    if (!profile) return;

    if (profile.onboarding_status === 'bridge_rejected') {
      this.logger.log(
        `Usuario ${userId} ya estaba marcado como bridge_rejected. Ignorando webhook duplicado.`,
      );
      return;
    }

    // 2. Actualizar kyc/kyb application
    const { data: kycApp } = await this.supabase
      .from('kyc_applications')
      .select('id')
      .eq('user_id', userId)
      .in('status', ['sent_to_bridge'])
      .maybeSingle();

    if (kycApp) {
      await this.supabase
        .from('kyc_applications')
        .update({ status: 'bridge_rejected' })
        .eq('id', kycApp.id);
    } else {
      // Try KYB
      await this.supabase
        .from('kyb_applications')
        .update({ status: 'bridge_rejected' })
        .eq('user_id', userId)
        .in('status', ['sent_to_bridge']);
    }

    // 2. Actualizar perfil
    await this.supabase
      .from('profiles')
      .update({ onboarding_status: 'bridge_rejected' })
      .eq('id', userId);

    // 3. Buscar review abierto y registrar evento
    const review = await this.findOpenReviewForUser(userId);
    if (review) {
      await this.supabase.from('compliance_review_events').insert({
        review_id: review.id,
        actor_id: userId,
        decision: 'BRIDGE_REJECTED',
        reason: `Bridge rechazó verificación — Issues: ${issues.join(', ')}`,
        metadata: {
          bridge_issues: issues,
          bridge_customer_id: bridgeCustomerId,
        },
      });
      // Review permanece abierto para que el staff pueda actuar
    }

    // 4. Notificar al staff (admins)
    const { data: staffUsers } = await this.supabase
      .from('profiles')
      .select('id')
      .in('role', ['staff', 'admin', 'super_admin'])
      .eq('is_active', true);

    const clientName = profile.full_name ?? profile.email ?? userId;

    for (const staff of staffUsers ?? []) {
      await this.supabase.from('notifications').insert({
        user_id: staff.id,
        type: 'alert',
        title: 'Bridge rechazó verificación',
        message: `Bridge rechazó la verificación de ${clientName}. Issues: ${issues.join(', ')}`,
      });
    }

    // 5. Notificar al cliente
    await this.supabase.from('notifications').insert({
      user_id: userId,
      type: 'alert',
      title: 'Observaciones en tu verificación',
      message:
        'Se encontraron observaciones durante la verificación de tu identidad. Nuestro equipo de soporte se pondrá en contacto contigo para los próximos pasos.',
    });

    // 6. Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'system',
      action: 'BRIDGE_REJECTED',
      table_name: 'profiles',
      record_id: userId,
      reason: `Bridge webhook rechazó — Issues: ${issues.join(', ')}`,
      new_values: {
        bridge_issues: issues,
        bridge_customer_id: bridgeCustomerId,
      },
      source: 'webhook',
    });
  }

  /**
   * Llamado por el webhook handler cuando Bridge devuelve status = 'incomplete'.
   * Registra el evento en el historial del compliance review, notifica al staff
   * (con motivos específicos) y deja el review ABIERTO para que el staff actúe.
   */
  async handleBridgeIncomplete(
    userId: string,
    bridgeCustomerId: string,
    issues: string[],
    additionalRequirements: string[],
  ): Promise<void> {
    this.logger.warn(
      `Bridge marcó cuenta como incomplete para user ${userId} — issues: ${issues.join(', ')}`,
    );

    const { data: profile } = await this.supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', userId)
      .maybeSingle();

    if (!profile) return;

    const clientName = profile.full_name ?? profile.email ?? userId;

    // 1. Registrar evento inmutable en el historial del compliance review
    const review = await this.findOpenReviewForUser(userId);
    if (review) {
      await this.supabase.from('compliance_review_events').insert({
        review_id: review.id,
        actor_id: userId,
        decision: 'BRIDGE_INCOMPLETE',
        reason: `Bridge devolvió status=incomplete — Issues: ${issues.join(', ')}${additionalRequirements.length ? `. Req adicionales: ${additionalRequirements.join(', ')}` : ''}`,
        metadata: {
          bridge_issues: issues,
          additional_requirements: additionalRequirements,
          bridge_customer_id: bridgeCustomerId,
        },
      });
      // El review se mantiene ABIERTO para que el staff tome acción
    }

    // 2. Notificar a cada miembro del staff con el detalle de los issues
    const { data: staffUsers } = await this.supabase
      .from('profiles')
      .select('id')
      .in('role', ['staff', 'admin', 'super_admin'])
      .eq('is_active', true);

    for (const staff of staffUsers ?? []) {
      await this.supabase.from('notifications').insert({
        user_id: staff.id,
        type: 'compliance_alert',
        title: 'KYC incompleto en Bridge — acción requerida',
        message: `Bridge marcó la verificación de ${clientName} como incompleta. Issues: ${issues.join(', ')}${additionalRequirements.length ? `. Req adicionales: ${additionalRequirements.join(', ')}` : ''}.`,
        reference_type: 'kyc_application',
      });
    }

    // 3. Notificar al cliente con mensaje genérico (sin exponer detalles técnicos)
    await this.supabase.from('notifications').insert({
      user_id: userId,
      type: 'alert',
      title: 'Tu verificación requiere información adicional',
      message:
        'Tu verificación está siendo revisada y se necesita información adicional. Nuestro equipo de soporte se pondrá en contacto contigo pronto.',
    });

    // 4. Audit log — registro permanente de lo que Bridge reportó
    await this.supabase.from('audit_logs').insert({
      performed_by: userId,
      role: 'system',
      action: 'BRIDGE_INCOMPLETE',
      table_name: 'profiles',
      record_id: userId,
      reason: `Bridge webhook reportó status=incomplete — Issues: ${issues.join(', ')}`,
      new_values: {
        bridge_issues: issues,
        additional_requirements: additionalRequirements,
        bridge_customer_id: bridgeCustomerId,
      },
      source: 'webhook',
    });
  }

  /**
   * Busca el compliance_review abierto más reciente para un usuario.
   */
  private async findOpenReviewForUser(
    userId: string,
  ): Promise<{ id: string } | null> {
    // Buscar por kyc_application
    const { data: kycApp } = await this.supabase
      .from('kyc_applications')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (kycApp) {
      const { data: review } = await this.supabase
        .from('compliance_reviews')
        .select('id')
        .eq('subject_type', 'kyc_applications')
        .eq('subject_id', kycApp.id)
        .eq('status', 'open')
        .maybeSingle();
      if (review) return review;
    }

    // Buscar por kyb_application
    const { data: kybApp } = await this.supabase
      .from('kyb_applications')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (kybApp) {
      const { data: review } = await this.supabase
        .from('compliance_reviews')
        .select('id')
        .eq('subject_type', 'kyb_applications')
        .eq('subject_id', kybApp.id)
        .eq('status', 'open')
        .maybeSingle();
      if (review) return review;
    }

    return null;
  }

  async rejectReview(reviewId: string, actorId: string, reason: string, actorRole: string) {
    const { data: review } = await this.supabase
      .from('compliance_reviews')
      .select('subject_type, subject_id, status')
      .eq('id', reviewId)
      .single();

    if (!review) throw new NotFoundException('Review no encontrado');
    if (review.status === 'closed')
      throw new BadRequestException('El review ya está cerrado');

    // 1. Inmutable Event
    await this.supabase.from('compliance_review_events').insert({
      review_id: reviewId,
      actor_id: actorId,
      decision: 'REJECTED',
      reason,
    });

    // 2. Cerrar Review
    await this.supabase
      .from('compliance_reviews')
      .update({ status: 'closed', closed_at: new Date().toISOString() })
      .eq('id', reviewId);

    // 3. Aplicar rechazo
    await this.applyRejectionToSubject(
      review.subject_type,
      review.subject_id,
      actorId,
      reason,
    );

    // 4. Audit Log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: 'REJECT_COMPLIANCE_REVIEW',
      table_name: 'compliance_reviews',
      record_id: reviewId,
      reason,
      source: 'admin_panel',
    });

    return { message: 'Review rechazado' };
  }

  async requestChanges(
    reviewId: string,
    actorId: string,
    reason: string,
    actorRole: string,
    requiredActions?: string[],
    fieldObservations?: Record<string, string>,
  ) {
    const { data: review } = await this.supabase
      .from('compliance_reviews')
      .select('subject_type, subject_id, status')
      .eq('id', reviewId)
      .single();

    if (!review) throw new NotFoundException('Review no encontrado');
    if (review.status === 'closed')
      throw new BadRequestException('El review ya está cerrado');

    // 1. Evento inmutable de la decisión (NEEDS_CHANGES)
    await this.supabase.from('compliance_review_events').insert({
      review_id: reviewId,
      actor_id: actorId,
      decision: 'NEEDS_CHANGES',
      reason,
      metadata: {
        ...(requiredActions ? { required_actions: requiredActions } : {}),
        ...(fieldObservations ? { field_observations: fieldObservations } : {}),
      },
    });

    // 2. El review queda ABIERTO (no cerrado) — el cliente debe corregir
    await this.supabase
      .from('compliance_reviews')
      .update({ priority: 'normal' })
      .eq('id', reviewId);

    // 3. Snapshot datos actuales en previous_data para Diff View
    //    y actualizar estado a 'needs_review' con observaciones
    if (review.subject_type === 'kyc_applications') {
      // Leer datos actuales para el snapshot
      const { data: currentApp } = await this.supabase
        .from('kyc_applications')
        .select('*, people (*)')
        .eq('id', review.subject_id)
        .maybeSingle();

      const snapshotData = currentApp ? this.mapKycToFormData(currentApp) : {};

      await this.supabase
        .from('kyc_applications')
        .update({
          status: 'needs_review',
          observations: reason,
          field_observations: fieldObservations ?? {},
          previous_data: snapshotData,
        })
        .eq('id', review.subject_id);
    } else if (review.subject_type === 'kyb_applications') {
      // Leer datos actuales para el snapshot
      const { data: currentApp } = await this.supabase
        .from('kyb_applications')
        .select('*, businesses (*, business_directors(*), business_ubos(*))')
        .eq('id', review.subject_id)
        .maybeSingle();

      const snapshotData = currentApp?.businesses ?? currentApp ?? {};

      await this.supabase
        .from('kyb_applications')
        .update({
          status: 'needs_review',
          observations: reason,
          field_observations: fieldObservations ?? {},
          previous_data: snapshotData,
        })
        .eq('id', review.subject_id);
    }

    // 4. Notificar al cliente
    let userIdNotified: string | null = null;
    if (review.subject_type === 'kyc_applications') {
      const { data } = await this.supabase
        .from('kyc_applications')
        .select('user_id')
        .eq('id', review.subject_id)
        .single();
      userIdNotified = data?.user_id;
    } else if (review.subject_type === 'kyb_applications') {
      const { data } = await this.supabase
        .from('kyb_applications')
        .select('requester_user_id')
        .eq('id', review.subject_id)
        .single();
      userIdNotified = data?.requester_user_id;
    }

    if (userIdNotified) {
      // C2 FIX: Sincronizar profiles.onboarding_status con estado específico
      // para que el wizard del cliente redirija al paso correcto.
      const nextProfileStatus =
        review.subject_type === 'kyc_applications'
          ? 'kyc_started'
          : 'kyb_started';
      await this.supabase
        .from('profiles')
        .update({ onboarding_status: nextProfileStatus })
        .eq('id', userIdNotified);

      const actionsMsg = requiredActions?.length
        ? `\n\nAcciones requeridas: ${requiredActions.join(', ')}`
        : '';
      const fieldsMsg = fieldObservations && Object.keys(fieldObservations).length > 0
        ? `\n\nCampos a corregir: ${Object.keys(fieldObservations).join(', ')}`
        : '';
      await this.supabase.from('notifications').insert({
        user_id: userIdNotified,
        type: 'alert',
        title: 'Se requieren correcciones',
        message: `Su expediente necesita correcciones. ${reason}${actionsMsg}${fieldsMsg}`,
      });
    }

    // 5. Audit log
    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: 'REQUEST_CHANGES_COMPLIANCE_REVIEW',
      table_name: 'compliance_reviews',
      record_id: reviewId,
      reason,
      new_values: { required_actions: requiredActions },
      source: 'admin_panel',
    });

    return { message: 'Se solicitó al cliente que corrija su expediente' };
  }

  // ── HELPERS: Subjects ─────────────────────────────────────────────

  /**
   * Envía los datos del sujeto a Bridge para verificación.
   * Pone estados intermedios (sent_to_bridge / pending_bridge).
   * NO aprueba la cuenta — eso lo hará el webhook de Bridge.
   */
  private async sendToBridgeSubject(
    subjectType: string,
    subjectId: string,
    actorId: string,
    reason: string,
  ): Promise<void> {
    switch (subjectType) {
      case 'kyc_applications': {
        const { data: kyc } = await this.supabase
          .from('kyc_applications')
          .update({ status: 'sent_to_bridge' })
          .eq('id', subjectId)
          .select('user_id, person_id')
          .single();

        if (kyc?.user_id) {
          // Sincronizar full_name desde la tabla `people`
          const profileUpdate: Record<string, any> = {
            onboarding_status: 'pending_bridge',
          };
          if (kyc.person_id) {
            const { data: person } = await this.supabase
              .from('people')
              .select('first_name, last_name')
              .eq('id', kyc.person_id)
              .maybeSingle();
            if (person?.first_name) {
              profileUpdate.full_name = [person.first_name, person.last_name]
                .filter(Boolean)
                .join(' ')
                .trim();
            }
          }

          await this.supabase
            .from('profiles')
            .update(profileUpdate)
            .eq('id', kyc.user_id);

          // Registra en Bridge (crea bridge_customer + bridge_kyc_link)
          // La aprobación real vendrá del webhook — aquí solo mandamos los datos.
          try {
            await this.bridgeCustomerService.registerCustomerInBridge(
              kyc.user_id,
            );
          } catch (err) {
            this.logger.error(`Error registrando cliente en Bridge: ${err}`);
            // Revertir a needs_review para que el staff pueda reintentar
            await this.supabase
              .from('kyc_applications')
              .update({ status: 'needs_review' })
              .eq('id', subjectId);
            await this.supabase
              .from('profiles')
              .update({ onboarding_status: 'kyc_started' })
              .eq('id', kyc.user_id);
            throw new BadRequestException(
              `Error enviando a Bridge: ${(err as Error).message}. El expediente ha sido devuelto para revisión.`,
            );
          }
        }
        break;
      }
      case 'kyb_applications': {
        const { data: kyb } = await this.supabase
          .from('kyb_applications')
          .update({ status: 'sent_to_bridge' })
          .eq('id', subjectId)
          .select('requester_user_id, business_id')
          .single();

        if (kyb?.requester_user_id) {
          // Sincronizar full_name desde la tabla `businesses`
          const profileUpdate: Record<string, any> = {
            onboarding_status: 'pending_bridge',
          };
          if (kyb.business_id) {
            const { data: business } = await this.supabase
              .from('businesses')
              .select('legal_name')
              .eq('id', kyb.business_id)
              .maybeSingle();
            if (business?.legal_name) {
              profileUpdate.full_name = business.legal_name.trim();
            }
          }

          await this.supabase
            .from('profiles')
            .update(profileUpdate)
            .eq('id', kyb.requester_user_id);

          try {
            await this.bridgeCustomerService.registerCustomerInBridge(
              kyb.requester_user_id,
            );
          } catch (err) {
            this.logger.error(`Error registrando negocio en Bridge: ${err}`);
            await this.supabase
              .from('kyb_applications')
              .update({ status: 'needs_review' })
              .eq('id', subjectId);
            await this.supabase
              .from('profiles')
              .update({ onboarding_status: 'kyb_started' })
              .eq('id', kyb.requester_user_id);
            throw new BadRequestException(
              `Error enviando a Bridge: ${(err as Error).message}. El expediente ha sido devuelto para revisión.`,
            );
          }
        }
        break;
      }
      case 'payout_request': {
        // Payouts se aprueban directamente (no van por flujo Bridge KYC)
        await this.bridgeService.approvePayout(subjectId, actorId);
        break;
      }
    }
  }

  private async applyRejectionToSubject(
    subjectType: string,
    subjectId: string,
    actorId: string,
    reason: string,
  ): Promise<void> {
    // C1 FIX: Resolver user_id ANTES del update para reusar en profile sync + notificación.
    let userIdNotified: string | null = null;

    switch (subjectType) {
      case 'kyc_applications': {
        const { data: kycApp } = await this.supabase
          .from('kyc_applications')
          .select('user_id')
          .eq('id', subjectId)
          .single();
        userIdNotified = kycApp?.user_id ?? null;

        await this.supabase
          .from('kyc_applications')
          .update({ status: 'rejected' })
          .eq('id', subjectId);

        // C1 FIX: Sincronizar profiles.onboarding_status = 'rejected'
        if (userIdNotified) {
          await this.supabase
            .from('profiles')
            .update({ onboarding_status: 'rejected' })
            .eq('id', userIdNotified);
        }
        break;
      }

      case 'kyb_applications': {
        const { data: kybApp } = await this.supabase
          .from('kyb_applications')
          .select('requester_user_id')
          .eq('id', subjectId)
          .single();
        userIdNotified = kybApp?.requester_user_id ?? null;

        await this.supabase
          .from('kyb_applications')
          .update({ status: 'rejected' })
          .eq('id', subjectId);

        // C1 FIX: Sincronizar profiles.onboarding_status = 'rejected'
        if (userIdNotified) {
          await this.supabase
            .from('profiles')
            .update({ onboarding_status: 'rejected' })
            .eq('id', userIdNotified);
        }
        break;
      }

      case 'payout_request': {
        // Rechazar payout en Bridge Service (libera saldos)
        await this.bridgeService.rejectPayout(subjectId, reason, actorId);

        const { data: payoutReq } = await this.supabase
          .from('payout_requests')
          .select('user_id')
          .eq('id', subjectId)
          .single();
        userIdNotified = payoutReq?.user_id ?? null;
        break;
      }
    }

    if (userIdNotified) {
      await this.supabase.from('notifications').insert({
        user_id: userIdNotified,
        type: 'alert',
        title: 'Revisión Rechazada',
        message: `Su solicitud ha sido rechazada. Razón: ${reason}`,
      });
    }
  }

  // ── USER LIMITS ───────────────────────────────────────────────────

  async setTransactionLimits(
    userId: string,
    actorId: string,
    dto: SetLimitsDto,
    actorRole: string,
  ) {
    const { data: current } = await this.supabase
      .from('transaction_limits')
      .select('*')
      .eq('user_id', userId)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();

    const newLimits = {
      user_id: userId,
      daily_deposit_limit:
        dto.daily_deposit_limit ?? current?.daily_deposit_limit,
      daily_payout_limit: dto.daily_payout_limit ?? current?.daily_payout_limit,
      single_txn_limit: dto.single_txn_limit ?? current?.single_txn_limit,
      applied_by: actorId,
      reason: dto.reason,
    };

    const { data, error } = await this.supabase
      .from('transaction_limits')
      .insert(newLimits)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: 'SET_TRANSACTION_LIMITS',
      table_name: 'transaction_limits',
      record_id: userId,
      reason: dto.reason,
      new_values: newLimits,
      source: 'admin_panel',
    });

    return data;
  }
}

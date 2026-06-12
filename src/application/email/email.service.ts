import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ZeptoMailClient } from './zeptomail.client';
import { ZeptoMailRecipient } from './zeptomail.types';
import { FOOTER_WAVE_CID } from './email-templates/base-layout.template';
import {
  buildComplianceApprovedEmail,
  buildComplianceCorrectionsRequestedEmail,
  buildComplianceIncompleteEmail,
  buildComplianceRejectedEmail,
} from './email-templates/compliance.templates';
import {
  buildPaymentOrderCompletedEmail,
  buildPaymentOrderFailedEmail,
} from './email-templates/payment-order.templates';

export interface EmailRecipient {
  email: string;
  name?: string;
}

export interface SendEmailParams {
  to: EmailRecipient;
  subject: string;
  html: string;
  text?: string;
  cc?: EmailRecipient[];
  bcc?: EmailRecipient[];
  clientReference?: string;
}

export interface PaymentOrderEmailDetails {
  amount: number | string;
  currency: string;
  reference: string;
}

/**
 * Fachada pública para el envío de correos transaccionales vía ZeptoMail.
 *
 * Principio clave: NUNCA lanza excepciones. Un fallo de ZeptoMail (servicio
 * caído, token inválido, etc.) jamás debe romper el flujo que dispara el correo
 * (webhooks, acciones de compliance, etc.). Siempre devuelve `boolean`.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly footerWaveBase64 = this.loadFooterWave();

  constructor(private readonly zeptoMail: ZeptoMailClient) {}

  get isConfigured(): boolean {
    return this.zeptoMail.isConfigured;
  }

  private toRecipient(r: EmailRecipient): ZeptoMailRecipient {
    return { email_address: { address: r.email, name: r.name } };
  }

  private loadFooterWave(): string | undefined {
    const assetPath = path.join(
      process.cwd(),
      'assets',
      'email-footer-wave.png',
    );

    try {
      return fs.readFileSync(assetPath).toString('base64');
    } catch {
      this.logger.warn(`No se pudo cargar la onda del footer: ${assetPath}`);
      return undefined;
    }
  }

  async sendEmail(params: SendEmailParams): Promise<boolean> {
    if (!this.isConfigured) {
      this.logger.warn(
        `ZeptoMail no configurado, omitiendo envío de email a ${params.to.email}`,
      );
      return false;
    }

    try {
      await this.zeptoMail.send({
        to: [this.toRecipient(params.to)],
        cc: params.cc?.map((r) => this.toRecipient(r)),
        bcc: params.bcc?.map((r) => this.toRecipient(r)),
        subject: params.subject,
        htmlbody: params.html,
        textbody: params.text,
        track_opens: false,
        track_clicks: false,
        client_reference: params.clientReference,
        inline_images: this.footerWaveBase64
          ? [
              {
                content: this.footerWaveBase64,
                mime_type: 'image/png',
                cid: FOOTER_WAVE_CID,
              },
            ]
          : undefined,
      });
      return true;
    } catch (err) {
      this.logger.error(
        `Error enviando email a ${params.to.email}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  // ── Correos de verificación KYB/KYC (Bridge) ──────────────────────

  async sendComplianceApprovedEmail(to: EmailRecipient): Promise<boolean> {
    const { subject, html, text } = buildComplianceApprovedEmail({
      name: to.name,
    });
    return this.sendEmail({ to, subject, html, text });
  }

  async sendComplianceRejectedEmail(to: EmailRecipient): Promise<boolean> {
    const { subject, html, text } = buildComplianceRejectedEmail({
      name: to.name,
    });
    return this.sendEmail({ to, subject, html, text });
  }

  async sendComplianceIncompleteEmail(to: EmailRecipient): Promise<boolean> {
    const { subject, html, text } = buildComplianceIncompleteEmail({
      name: to.name,
    });
    return this.sendEmail({ to, subject, html, text });
  }

  async sendComplianceCorrectionsRequestedEmail(
    to: EmailRecipient,
    details: {
      reason: string;
      requiredActions?: string[];
      fieldObservations?: Record<string, string>;
    },
  ): Promise<boolean> {
    const { subject, html, text } = buildComplianceCorrectionsRequestedEmail({
      name: to.name,
      reason: details.reason,
      requiredActions: details.requiredActions,
      fieldObservations: details.fieldObservations,
    });
    return this.sendEmail({ to, subject, html, text });
  }

  // ── Correos de órdenes de pago ("expedientes") ────────────────────

  async sendPaymentOrderCompletedEmail(
    to: EmailRecipient,
    details: PaymentOrderEmailDetails,
  ): Promise<boolean> {
    const { subject, html, text } = buildPaymentOrderCompletedEmail({
      name: to.name,
      ...details,
    });
    return this.sendEmail({ to, subject, html, text });
  }

  async sendPaymentOrderFailedEmail(
    to: EmailRecipient,
    details: PaymentOrderEmailDetails,
  ): Promise<boolean> {
    const { subject, html, text } = buildPaymentOrderFailedEmail({
      name: to.name,
      ...details,
    });
    return this.sendEmail({ to, subject, html, text });
  }
}

import {
  APP_URL,
  greetingName,
  renderButton,
  renderEmailLayout,
  renderEyebrowHeading,
} from './base-layout.template';

export interface PaymentOrderEmailContent {
  subject: string;
  html: string;
  text: string;
}

interface PaymentOrderEmailParams {
  name?: string | null;
  amount: number | string;
  currency: string;
  reference: string;
}

function greeting(name?: string | null): string {
  const first = greetingName(name);
  return first ? `Hola ${first},` : 'Hola,';
}

function formatAmount(amount: number | string): string {
  return Number(amount).toFixed(2);
}

export function buildPaymentOrderCompletedEmail(
  params: PaymentOrderEmailParams,
): PaymentOrderEmailContent {
  const subject = 'Tu orden de pago en Guira fue completada';
  const intro = greeting(params.name);
  const message = `Tu orden de pago por ${formatAmount(params.amount)} ${params.currency} (referencia ${params.reference}) se completó exitosamente.`;

  const html = renderEmailLayout({
    title: subject,
    previewText: message,
    bodyHtml: `
      ${renderEyebrowHeading('Orden completada', '¡Tu orden de pago fue completada!')}
      <p style="margin:0 0 16px;">${intro}</p>
      <p style="margin:0;">${message}</p>
      ${renderButton('Ir a Guira', APP_URL)}
    `,
  });

  const text = `${intro}\n\n${message}`;
  return { subject, html, text };
}

export function buildPaymentOrderFailedEmail(
  params: PaymentOrderEmailParams,
): PaymentOrderEmailContent {
  const subject = 'Tu orden de pago en Guira no pudo completarse';
  const intro = greeting(params.name);
  const message = `Tu orden de pago por ${formatAmount(params.amount)} ${params.currency} (referencia ${params.reference}) no pudo completarse. Si se realizó algún cargo a tu cuenta, el monto correspondiente será reembolsado. Si tienes dudas, contacta a nuestro equipo de soporte.`;

  const html = renderEmailLayout({
    title: subject,
    previewText: message,
    bodyHtml: `
      ${renderEyebrowHeading('Orden de pago', 'Tu orden de pago no pudo completarse')}
      <p style="margin:0 0 16px;">${intro}</p>
      <p style="margin:0;">${message}</p>
      ${renderButton('Ir a Guira', APP_URL)}
    `,
  });

  const text = `${intro}\n\n${message}`;
  return { subject, html, text };
}

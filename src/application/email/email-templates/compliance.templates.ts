import {
  escapeHtml,
  greetingName,
  renderEmailLayout,
} from './base-layout.template';

export interface ComplianceEmailContent {
  subject: string;
  html: string;
  text: string;
}

interface ComplianceEmailParams {
  name?: string | null;
}

function greeting(name?: string | null): string {
  const first = greetingName(name);
  return first ? `Hola ${first},` : 'Hola,';
}

export function buildComplianceApprovedEmail(
  params: ComplianceEmailParams,
): ComplianceEmailContent {
  const subject = '¡Tu cuenta Guira ha sido verificada!';
  const intro = greeting(params.name);
  const message =
    'Tu identidad fue verificada exitosamente. Ya puedes usar todos los servicios de Guira.';

  const html = renderEmailLayout({
    title: subject,
    previewText: message,
    bodyHtml: `
      <p style="margin:0 0 16px;">${intro}</p>
      <p style="margin:0 0 16px;">${message}</p>
      <p style="margin:0;">Gracias por confiar en Guira.</p>
    `,
  });

  const text = `${intro}\n\n${message}\n\nGracias por confiar en Guira.`;

  return { subject, html, text };
}

export function buildComplianceRejectedEmail(
  params: ComplianceEmailParams,
): ComplianceEmailContent {
  const subject = 'Actualización sobre tu verificación en Guira';
  const intro = greeting(params.name);
  const message =
    'Se encontraron observaciones durante la verificación de tu identidad. Nuestro equipo de soporte se pondrá en contacto contigo para los próximos pasos.';

  const html = renderEmailLayout({
    title: subject,
    previewText: message,
    bodyHtml: `
      <p style="margin:0 0 16px;">${intro}</p>
      <p style="margin:0;">${message}</p>
    `,
  });

  const text = `${intro}\n\n${message}`;

  return { subject, html, text };
}

interface ComplianceCorrectionsRequestedParams extends ComplianceEmailParams {
  reason: string;
  requiredActions?: string[];
  fieldObservations?: Record<string, string>;
}

export function buildComplianceCorrectionsRequestedEmail(
  params: ComplianceCorrectionsRequestedParams,
): ComplianceEmailContent {
  const subject = 'Tu expediente en Guira necesita correcciones';
  const intro = greeting(params.name);
  const message =
    'Hemos revisado tu expediente y necesitamos que realices algunas correcciones antes de continuar con la verificación.';
  const reason = params.reason.trim();

  const requiredActionsHtml = params.requiredActions?.length
    ? `
      <p style="margin:16px 0 8px; font-weight:600;">Acciones requeridas:</p>
      <ul style="margin:0 0 16px; padding-left:20px;">
        ${params.requiredActions
          .map((action) => `<li>${escapeHtml(action)}</li>`)
          .join('')}
      </ul>`
    : '';

  const fieldObservationKeys = params.fieldObservations
    ? Object.keys(params.fieldObservations)
    : [];
  const fieldObservationsHtml = fieldObservationKeys.length
    ? `
      <p style="margin:16px 0 8px; font-weight:600;">Campos a corregir:</p>
      <ul style="margin:0 0 16px; padding-left:20px;">
        ${fieldObservationKeys
          .map((field) => {
            const observation = params.fieldObservations![field];
            return `<li>${escapeHtml(field)}: ${escapeHtml(observation)}</li>`;
          })
          .join('')}
      </ul>`
    : '';

  const html = renderEmailLayout({
    title: subject,
    previewText: message,
    bodyHtml: `
      <p style="margin:0 0 16px;">${intro}</p>
      <p style="margin:0 0 16px;">${message}</p>
      <p style="margin:0 0 16px;">${escapeHtml(reason)}</p>
      ${requiredActionsHtml}
      ${fieldObservationsHtml}
      <p style="margin:0;">Inicia sesión en tu cuenta de Guira para corregir y reenviar tu información.</p>
    `,
  });

  const requiredActionsText = params.requiredActions?.length
    ? `\n\nAcciones requeridas:\n${params.requiredActions.map((a) => `- ${a}`).join('\n')}`
    : '';
  const fieldObservationsText = fieldObservationKeys.length
    ? `\n\nCampos a corregir:\n${fieldObservationKeys
        .map((field) => `- ${field}: ${params.fieldObservations![field]}`)
        .join('\n')}`
    : '';

  const text = `${intro}\n\n${message}\n\n${reason}${requiredActionsText}${fieldObservationsText}\n\nInicia sesión en tu cuenta de Guira para corregir y reenviar tu información.`;

  return { subject, html, text };
}

export function buildComplianceIncompleteEmail(
  params: ComplianceEmailParams,
): ComplianceEmailContent {
  const subject = 'Tu verificación en Guira requiere información adicional';
  const intro = greeting(params.name);
  const message =
    'Tu verificación está siendo revisada y se necesita información adicional. Nuestro equipo de soporte se pondrá en contacto contigo pronto.';

  const html = renderEmailLayout({
    title: subject,
    previewText: message,
    bodyHtml: `
      <p style="margin:0 0 16px;">${intro}</p>
      <p style="margin:0;">${message}</p>
    `,
  });

  const text = `${intro}\n\n${message}`;

  return { subject, html, text };
}

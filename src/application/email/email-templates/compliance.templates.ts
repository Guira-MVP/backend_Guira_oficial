import { greetingName, renderEmailLayout } from './base-layout.template';

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

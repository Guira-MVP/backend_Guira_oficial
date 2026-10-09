import {
  APP_URL,
  escapeHtml,
  renderButton,
  renderEmailLayout,
  renderEyebrowHeading,
} from './base-layout.template';

export interface NewUserAlertEmailContent {
  subject: string;
  html: string;
  text: string;
}

interface NewUserAlertEmailParams {
  email: string;
  fullName?: string | null;
  accountType?: string | null;
  /** ISO timestamp de la verificación del correo. */
  verifiedAt: string;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  personal: 'Personal',
  company: 'Empresa',
};

function accountTypeLabel(accountType?: string | null): string {
  return (accountType && ACCOUNT_TYPE_LABELS[accountType]) || 'Sin definir';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-BO', {
    timeZone: 'America/La_Paz',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Aviso interno: un cliente nuevo verificó su correo. Es deliberadamente
 * mínimo — solo identifica al cliente para que el equipo revise su estado en
 * el panel. No incluye teléfono, identificación fiscal ni documentos.
 */
export function buildNewUserAlertEmail(
  params: NewUserAlertEmailParams,
): NewUserAlertEmailContent {
  const subject = 'Nuevo cliente registrado en Guira';
  const name = params.fullName?.trim() || 'Sin nombre';
  const type = accountTypeLabel(params.accountType);
  const when = formatDate(params.verifiedAt);
  const panelUrl = `${APP_URL}/admin/users`;

  const row = (label: string, value: string) =>
    `<tr>
      <td style="padding:6px 16px 6px 0; color:#6b7280;">${label}</td>
      <td style="padding:6px 0;"><strong>${escapeHtml(value)}</strong></td>
    </tr>`;

  const html = renderEmailLayout({
    title: subject,
    previewText: `${name} acaba de registrarse en Guira.`,
    bodyHtml: `
      ${renderEyebrowHeading('Aviso interno', 'Nuevo cliente registrado')}
      <p style="margin:0 0 16px;">Un nuevo cliente verificó su correo y entró a la plataforma.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
        ${row('Nombre', name)}
        ${row('Correo', params.email)}
        ${row('Tipo de cuenta', type)}
        ${row('Fecha', when)}
      </table>
      ${renderButton('Ver clientes en el panel', panelUrl)}
    `,
  });

  const text = [
    'Un nuevo cliente verificó su correo y entró a la plataforma.',
    '',
    `Nombre: ${name}`,
    `Correo: ${params.email}`,
    `Tipo de cuenta: ${type}`,
    `Fecha: ${when}`,
    '',
    `Revisar en el panel: ${panelUrl}`,
  ].join('\n');

  return { subject, html, text };
}

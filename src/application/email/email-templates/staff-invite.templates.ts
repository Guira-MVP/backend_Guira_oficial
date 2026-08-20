import {
  escapeHtml,
  greetingName,
  renderButton,
  renderEmailLayout,
  renderEyebrowHeading,
  renderListSection,
} from './base-layout.template';

export interface StaffInviteEmailContent {
  subject: string;
  html: string;
  text: string;
}

interface StaffInviteEmailParams {
  name?: string | null;
  /** Link de invitación generado con generateLink({ type: 'invite' }). */
  inviteUrl: string;
  /** Rol asignado, en texto legible para la persona destinataria. */
  roleLabel: string;
  /** Nombre de quien cursa la invitación, si se conoce. */
  invitedByName?: string | null;
}

function greeting(name?: string | null): string {
  const first = greetingName(name);
  return first ? `Hola ${first},` : 'Hola,';
}

/**
 * Correo de alta de personal interno.
 *
 * No transporta contraseña: el enlace lleva a la persona a definir la suya.
 * Es deliberado — así la credencial no existe hasta que la crea su titular,
 * nadie más la conoce y no queda escrita en ningún buzón.
 */
export function buildStaffInviteEmail(
  params: StaffInviteEmailParams,
): StaffInviteEmailContent {
  const subject = 'Tu acceso al panel de Guira';
  const intro = greeting(params.name);
  const invitedBy = params.invitedByName
    ? ` por ${escapeHtml(params.invitedByName)}`
    : '';

  const message =
    `Se te ha dado de alta${invitedBy} en el panel interno de Guira con el rol de ` +
    `<strong>${escapeHtml(params.roleLabel)}</strong>.`;

  const html = renderEmailLayout({
    title: subject,
    previewText: 'Activa tu acceso al panel interno de Guira.',
    bodyHtml: `
      ${renderEyebrowHeading('Acceso al panel', 'Activa tu cuenta')}
      <p style="margin:0 0 16px;">${intro}</p>
      <p style="margin:0 0 16px;">${message}</p>
      <p style="margin:0 0 16px;">
        Para entrar por primera vez necesitas establecer tu contraseña. Nadie más la conoce
        ni puede verla: la defines tú desde el enlace de abajo.
      </p>
      ${renderButton('Establecer mi contraseña', params.inviteUrl)}
      ${renderListSection('Ten en cuenta', [
        'El enlace es de un solo uso y caduca en 24 horas.',
        'Si caduca, pide a un administrador que te reenvíe la invitación.',
        'Guira nunca te pedirá tu contraseña por correo, chat ni teléfono.',
      ])}
      <p style="margin:16px 0 0;">
        Si no esperabas este correo, ignóralo y avisa al equipo.
      </p>
    `,
  });

  const text = [
    intro,
    '',
    `Se te ha dado de alta en el panel interno de Guira con el rol de ${params.roleLabel}.`,
    '',
    'Para entrar por primera vez, establece tu contraseña en este enlace:',
    params.inviteUrl,
    '',
    'El enlace es de un solo uso y caduca en 24 horas.',
    'Guira nunca te pedira tu contrasena por correo, chat ni telefono.',
    '',
    'Si no esperabas este correo, ignoralo y avisa al equipo.',
  ].join('\n');

  return { subject, html, text };
}

import {
  escapeHtml,
  greetingName,
  renderButton,
  renderEmailLayout,
  renderEyebrowHeading,
  renderListSection,
} from './base-layout.template';

export interface TeamInviteEmailContent {
  subject: string;
  html: string;
  text: string;
}

interface TeamInviteEmailParams {
  name?: string | null;
  /** URL con el token de invitación, hacia la pantalla de aceptación. */
  inviteUrl: string;
  /** Nombre de la empresa que invita. */
  companyName: string;
  /** Plantilla de permisos asignada, en texto legible. */
  presetLabel: string;
  /** Lista legible de lo que la persona podrá ver. */
  capabilityLabels: string[];
}

function greeting(name?: string | null): string {
  const first = greetingName(name);
  return first ? `Hola ${first},` : 'Hola,';
}

/**
 * Correo de invitación a formar parte del equipo de una cuenta cliente.
 *
 * Se detalla qué podrá ver la persona y —igual de importante— qué no podrá
 * hacer. Quien recibe esto necesita saber que no se le está dando control
 * sobre el dinero de la empresa: es lo que evita malentendidos y llamadas
 * al soporte.
 */
export function buildTeamInviteEmail(
  params: TeamInviteEmailParams,
): TeamInviteEmailContent {
  const subject = `${params.companyName} te invitó a su equipo en Guira`;
  const intro = greeting(params.name);
  const company = escapeHtml(params.companyName);

  const html = renderEmailLayout({
    title: subject,
    previewText: `Acceso de consulta a la cuenta de ${params.companyName}.`,
    bodyHtml: `
      ${renderEyebrowHeading('Invitación', 'Únete al equipo')}
      <p style="margin:0 0 16px;">${intro}</p>
      <p style="margin:0 0 16px;">
        <strong>${company}</strong> te dio acceso de consulta a su cuenta de Guira
        con el perfil <strong>${escapeHtml(params.presetLabel)}</strong>.
      </p>
      ${renderListSection(
        'Vas a poder',
        params.capabilityLabels.map((label) => escapeHtml(label)),
      )}
      ${renderListSection('No vas a poder', [
        'Mover dinero ni ordenar pagos.',
        'Crear, modificar ni cancelar expedientes.',
        'Cambiar la configuración de la cuenta.',
      ])}
      <p style="margin:0 0 16px;">
        Si todavía no tienes cuenta en Guira, el enlace te llevará a crearla. Usa
        este mismo correo al registrarte: la invitación solo se activa con él.
      </p>
      ${renderButton('Ver la invitación', params.inviteUrl)}
      ${renderListSection('Ten en cuenta', [
        'El enlace caduca en 7 días.',
        'Puedes rechazar la invitación, y la empresa puede retirarte el acceso cuando quiera.',
        'Guira nunca te pedirá tu contraseña por correo, chat ni teléfono.',
      ])}
      <p style="margin:16px 0 0;">
        Si no esperabas este correo, ignóralo: sin aceptar, nadie te da acceso a nada.
      </p>
    `,
  });

  const text = [
    intro,
    '',
    `${params.companyName} te dio acceso de consulta a su cuenta de Guira con el perfil ${params.presetLabel}.`,
    '',
    'Vas a poder:',
    ...params.capabilityLabels.map((label) => `- ${label}`),
    '',
    'No vas a poder mover dinero, ordenar pagos, crear o cancelar expedientes,',
    'ni cambiar la configuracion de la cuenta.',
    '',
    'Ver la invitacion:',
    params.inviteUrl,
    '',
    'Si todavia no tienes cuenta en Guira, el enlace te llevara a crearla.',
    'Usa este mismo correo al registrarte: la invitacion solo se activa con el.',
    '',
    'El enlace caduca en 7 dias.',
    'Guira nunca te pedira tu contrasena por correo, chat ni telefono.',
    '',
    'Si no esperabas este correo, ignoralo: sin aceptar, nadie te da acceso a nada.',
  ].join('\n');

  return { subject, html, text };
}

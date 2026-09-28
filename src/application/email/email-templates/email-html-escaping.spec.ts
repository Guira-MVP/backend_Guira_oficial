import {
  buildAssistedOnboardingReadyEmail,
  buildComplianceApprovedEmail,
  buildComplianceRejectedEmail,
} from './compliance.templates';
import { buildPaymentOrderCompletedEmail } from './payment-order.templates';
import { buildTeamInviteEmail } from './team-invite.templates';

/**
 * El nombre del saludo lo escribe el cliente al registrarse (y ahora el
 * registro va directo a Supabase, sin validación del backend). Si llegaba sin
 * escapar al HTML, cualquiera podía meter enlaces o imágenes en un correo que
 * sale con el dominio de Guira.
 */

const PAYLOAD =
  '<a/href=https://evil.example>Verifica</a><img/src=x/onerror=alert(1)>';

function expectEscaped(html: string) {
  expect(html).not.toContain('<a/href=https://evil.example>');
  expect(html).not.toContain('<img/src=x');
  expect(html).toContain('&lt;a/href=https://evil.example&gt;');
}

describe('Plantillas de correo — el nombre del cliente se escapa en el HTML', () => {
  it('onboarding asistido listo', () => {
    expectEscaped(buildAssistedOnboardingReadyEmail({ name: PAYLOAD }).html);
  });

  it('verificación aprobada', () => {
    expectEscaped(buildComplianceApprovedEmail({ name: PAYLOAD }).html);
  });

  it('orden de pago completada', () => {
    const { html } = buildPaymentOrderCompletedEmail({
      name: PAYLOAD,
      amount: 100,
      currency: 'USD',
      reference: 'ORD-1',
    } as never);
    expectEscaped(html);
  });

  it('el motivo de rechazo (puede venir de Bridge) también se escapa', () => {
    const { html } = buildComplianceRejectedEmail({
      name: 'Ana',
      reason: PAYLOAD,
    });
    expectEscaped(html);
  });

  it('la razón social del que invita no se cuela por el título ni la vista previa', () => {
    const { html } = buildTeamInviteEmail({
      name: 'Ana',
      inviteUrl: 'https://app.guiracorp.com/invitacion-equipo?token=x',
      companyName: PAYLOAD,
      presetLabel: 'Financiero',
      capabilityLabels: [],
    } as never);
    expectEscaped(html);
  });

  it('el texto plano conserva el nombre legible', () => {
    const { text } = buildAssistedOnboardingReadyEmail({ name: 'María José' });
    expect(text.startsWith('Hola María,')).toBe(true);
    expect(text).toContain('/onboarding');
  });
});

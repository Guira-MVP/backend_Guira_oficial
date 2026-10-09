import { parseRecipients } from './new-user-alert.service';
import { buildNewUserAlertEmail } from '../email/email-templates/new-user-alert.templates';

describe('parseRecipients', () => {
  it('separa, recorta, normaliza y quita duplicados e inválidos', () => {
    expect(
      parseRecipients(' A@x.com, b@y.com;a@x.com ,, no-es-correo, c@z '),
    ).toEqual(['a@x.com', 'b@y.com']);
  });

  it('devuelve vacío con null o vacío', () => {
    expect(parseRecipients(null)).toEqual([]);
    expect(parseRecipients('')).toEqual([]);
  });
});

describe('buildNewUserAlertEmail', () => {
  it('escapa el nombre del cliente en el HTML', () => {
    const { html } = buildNewUserAlertEmail({
      email: 'a@b.com',
      fullName: '<img/src=x/onerror=alert(1)>',
      accountType: 'personal',
      verifiedAt: new Date().toISOString(),
    });
    expect(html).not.toContain('<img/src=x');
    expect(html).toContain('&lt;img/src=x');
  });
});

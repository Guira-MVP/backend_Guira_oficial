// Paleta de marca "Oceanic Trust" — misma usada en core/pdf/pdf.service.ts
export const BRAND = {
  navy: '#050036',
  primary: '#0055FF',
  accent: '#00D6FF',
  surface: '#F4F6FF',
  muted: '#6B6E9E',
  border: '#D5D8EE',
  white: '#FFFFFF',
};

/**
 * Extrae el primer nombre de un nombre completo para usar en saludos.
 * Devuelve '' si no hay nombre disponible.
 */
export function greetingName(fullName?: string | null): string {
  if (!fullName) return '';
  const first = fullName.trim().split(/\s+/)[0];
  return first ?? '';
}

export interface EmailLayoutOptions {
  previewText?: string;
  title: string;
  bodyHtml: string;
}

/**
 * Envuelve el contenido de un correo en un layout HTML compatible con
 * clientes de correo (tabla centrada, estilos inline).
 */
export function renderEmailLayout(opts: EmailLayoutOptions): string {
  const { previewText, title, bodyHtml } = opts;

  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
  </head>
  <body style="margin:0; padding:0; background-color:${BRAND.surface}; font-family:Helvetica, Arial, sans-serif;">
    ${
      previewText
        ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${previewText}</div>`
        : ''
    }
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.surface};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:${BRAND.white}; border-radius:12px; overflow:hidden; border:1px solid ${BRAND.border};">
            <tr>
              <td style="padding:24px 32px; border-bottom:1px solid ${BRAND.border};">
                <span style="font-size:22px; font-weight:700; color:${BRAND.primary};">Guira</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px; color:${BRAND.navy}; font-size:15px; line-height:1.6;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px; background-color:${BRAND.surface}; border-top:1px solid ${BRAND.border};">
                <p style="margin:0; font-size:12px; color:${BRAND.muted};">
                  Este es un mensaje automático de Guira. Por favor no respondas a este correo.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Botón con CTA, compatible con Outlook (tabla + estilos inline).
 */
export function renderButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
  <tr>
    <td align="center" style="border-radius:8px; background-color:${BRAND.primary};">
      <a href="${url}" target="_blank" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:600; color:${BRAND.white}; text-decoration:none; border-radius:8px;">${label}</a>
    </td>
  </tr>
</table>`;
}

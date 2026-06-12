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

// Logo alojado en Supabase Storage (bucket público "brand-assets").
// Variante a color (no blanca) para que sea visible sobre fondo blanco en el email.
export const LOGO_URL =
  'https://hhvkphzfaxlwguvzguxf.supabase.co/storage/v1/object/public/brand-assets/logo-guira-email.png';

// URL de la aplicación Guira, usada en el botón de retorno al final de cada correo.
export const APP_URL = 'https://app.guiracorp.com';

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Extrae el primer nombre de un nombre completo para usar en saludos.
 * Devuelve '' si no hay nombre disponible.
 */
export function greetingName(fullName?: string | null): string {
  if (!fullName) return '';
  const first = fullName.trim().split(/\s+/)[0];
  return first ?? '';
}

/**
 * Escapa caracteres HTML especiales para insertar texto dinámico
 * (escrito por staff) de forma segura dentro del HTML del correo.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EmailLayoutOptions {
  previewText?: string;
  title: string;
  bodyHtml: string;
}

/**
 * Envuelve el contenido de un correo en un layout HTML compatible con
 * clientes de correo: tabla centrada de ancho fijo, estilos inline,
 * sin tarjetas/bordes — solo espaciado y un divisor sutil en el footer.
 */
export function renderEmailLayout(opts: EmailLayoutOptions): string {
  const { previewText, title, bodyHtml } = opts;
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${title}</title>
  </head>
  <body style="margin:0; padding:0; background-color:${BRAND.surface}; font-family:${FONT_STACK};">
    ${
      previewText
        ? `<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${previewText}</div>`
        : ''
    }
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.surface};">
      <tr>
        <td align="center" style="padding:48px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px; width:100%;">
            <tr>
              <td style="padding:0 4px 28px;">
                <img src="${LOGO_URL}" width="132" alt="Guira" style="display:block; height:auto; border:0; outline:none; text-decoration:none;" />
              </td>
            </tr>
            <tr>
              <td style="padding:0 4px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="height:3px; width:40px; background-color:${BRAND.primary}; border-radius:2px; font-size:0; line-height:0;">&nbsp;</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 4px; color:${BRAND.navy}; font-size:15px; line-height:1.65;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:48px 4px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="height:1px; background-color:${BRAND.border}; font-size:0; line-height:0;">&nbsp;</td>
                  </tr>
                </table>
                <p style="margin:20px 0 0; font-size:12px; color:${BRAND.muted}; line-height:1.6;">
                  Este es un mensaje automático de Guira. Por favor no respondas a este correo.
                </p>
                <p style="margin:8px 0 0; font-size:12px; color:${BRAND.muted};">
                  &copy; ${year} Guira. Todos los derechos reservados.
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
 * Encabezado de sección: etiqueta corta en mayúsculas + título principal.
 */
export function renderEyebrowHeading(eyebrow: string, heading: string): string {
  return `
    <p style="margin:0 0 8px; font-size:12px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:${BRAND.primary};">${eyebrow}</p>
    <h1 style="margin:0 0 20px; font-size:22px; line-height:1.35; font-weight:700; color:${BRAND.navy};">${heading}</h1>
  `;
}

/**
 * Lista de elementos separados por divisores finos (sin cajas/tarjetas),
 * precedida por una etiqueta corta en mayúsculas.
 */
export function renderListSection(title: string, items: string[]): string {
  if (!items.length) return '';

  const rows = items
    .map(
      (item) => `
      <tr>
        <td style="padding:12px 0; border-top:1px solid ${BRAND.border}; font-size:14px; line-height:1.55; color:${BRAND.navy};">${item}</td>
      </tr>`,
    )
    .join('');

  return `
    <p style="margin:28px 0 4px; font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:${BRAND.muted};">${title}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${rows}
    </table>
  `;
}

/**
 * Botón con CTA, compatible con Outlook (tabla + estilos inline).
 */
export function renderButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 4px;">
  <tr>
    <td style="border-radius:8px; background-color:${BRAND.primary};">
      <a href="${url}" target="_blank" style="display:inline-block; padding:13px 28px; font-size:14px; font-weight:600; color:${BRAND.white}; text-decoration:none; border-radius:8px; letter-spacing:0.01em;">${label}</a>
    </td>
  </tr>
</table>`;
}

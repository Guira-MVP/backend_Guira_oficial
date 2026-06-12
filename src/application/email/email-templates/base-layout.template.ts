// Paleta de marca "Oceanic Trust" — misma usada en core/pdf/pdf.service.ts
export const BRAND = {
  navy: '#050036',
  primary: '#0055FF',
  accent: '#00D6FF',
  surface: '#F4F6FF',
  muted: '#6B6E9E',
  mutedOnDark: '#94A3B8',
  border: '#D5D8EE',
  white: '#FFFFFF',
};

// Logo alojado en Supabase Storage (bucket público "brand-assets").
// Variante a color (no blanca) para que sea visible sobre fondo blanco en el email.
export const LOGO_URL =
  'https://hhvkphzfaxlwguvzguxf.supabase.co/storage/v1/object/public/brand-assets/logo-guira-email.png';

// URL de la aplicación Guira, usada en el botón de retorno al final de cada correo.
export const APP_URL = 'https://app.guiracorp.com';

export const WEBSITE_URL = 'https://www.guiracorp.com/';

export const FOOTER_WAVE_CID = 'guira-footer-wave';

const SOCIAL_LINKS = [
  {
    name: 'Instagram',
    url: 'https://www.instagram.com/guirabolivia/',
    icon: 'https://img.icons8.com/ios-filled/48/ffffff/instagram-new--v1.png',
  },
  {
    name: 'Facebook',
    url: 'https://www.facebook.com/profile.php?id=61590471265409&locale=es_LA',
    icon: 'https://img.icons8.com/ios-filled/48/ffffff/facebook-f.png',
  },
  {
    name: 'TikTok',
    url: 'https://www.tiktok.com/@guirabolivia?is_from_webapp=1&sender_device=pc',
    icon: 'https://img.icons8.com/ios-filled/48/ffffff/tiktok--v1.png',
  },
] as const;

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
  const socialLinksHtml = SOCIAL_LINKS.map(
    ({ name, url, icon }) => `
                      <td align="center" style="padding:0 6px;">
                        <a href="${url}" target="_blank" aria-label="${name}" style="display:inline-block; text-decoration:none;">
                          <img src="${icon}" width="22" height="22" alt="${name}" style="display:block; width:22px; height:22px; border:0; outline:none; text-decoration:none;" />
                        </a>
                      </td>`,
  ).join('');

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
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:${BRAND.white}; border-radius:16px; overflow:hidden;">
            <tr>
              <td style="padding:36px 40px 28px;">
                <img src="${LOGO_URL}" width="132" alt="Guira" style="display:block; height:auto; border:0; outline:none; text-decoration:none;" />
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="height:4px; width:44px; background-color:${BRAND.primary}; border-radius:2px; font-size:0; line-height:0;">&nbsp;</td>
                    <td style="height:4px; width:18px; background-color:${BRAND.accent}; border-radius:2px; font-size:0; line-height:0;">&nbsp;</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 44px; color:${BRAND.navy}; font-size:15px; line-height:1.65;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:0; background-color:${BRAND.navy}; font-size:0; line-height:0;">
                <img src="cid:${FOOTER_WAVE_CID}" width="600" height="80" alt="" style="display:block; width:100%; max-width:600px; height:auto; border:0; outline:none; text-decoration:none;" />
              </td>
            </tr>
            <tr>
              <td style="padding:0; background-color:${BRAND.navy};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" style="padding:36px 32px 0;">
                      <p style="margin:0; color:${BRAND.white}; font-size:24px; line-height:1.2; font-weight:700; letter-spacing:-0.02em;">Guira</p>
                      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;">
                        <tr>
                          ${socialLinksHtml}
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:28px 40px 0;">
                      <p style="margin:0; max-width:470px; color:${BRAND.mutedOnDark}; font-size:12px; line-height:1.6;">
                        Por tu seguridad, Guira nunca solicitará contraseñas, códigos de acceso ni información financiera confidencial por correo electrónico.
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:24px 40px 0;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="height:1px; background-color:${BRAND.accent}; opacity:0.45; font-size:0; line-height:0;">&nbsp;</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:22px 32px 34px;">
                      <p style="margin:0; font-size:12px; color:${BRAND.mutedOnDark}; line-height:1.6;">
                        Este es un mensaje automático. Por favor no respondas a este correo.
                      </p>
                      <p style="margin:8px 0 0; font-size:12px; color:${BRAND.mutedOnDark}; line-height:1.6;">
                        &copy; ${year} Guira. Todos los derechos reservados.
                      </p>
                      <p style="margin:10px 0 0; font-size:12px; line-height:1.6;">
                        <a href="${WEBSITE_URL}" target="_blank" style="color:${BRAND.accent}; font-weight:600; text-decoration:none;">www.guiracorp.com</a>
                      </p>
                    </td>
                  </tr>
                </table>
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

/**
 * Rangos de IP publicados por Cloudflare.
 *
 * Fuente oficial: https://www.cloudflare.com/ips-v4 y https://www.cloudflare.com/ips-v6
 * Última verificación: 2026-08-31
 *
 * Se declaran como constantes en vez de descargarlos en el arranque a
 * propósito: cambian muy rara vez y no queremos que el boot del backend
 * dependa de una petición de red externa. Si Cloudflare publica un rango
 * nuevo y esta lista se queda corta, el efecto es que `request.ip` vuelve a
 * resolver la IP del edge de Cloudflare — el comportamiento que había antes
 * de este cambio. Es un fallo suave, pero conviene revisar la lista de vez
 * en cuando.
 *
 * Se usan en `main.ts` como lista de proxies de confianza para Express
 * (`trust proxy`). Ver allí la explicación de por qué una lista de CIDRs es
 * preferible a un contador de saltos.
 */

const CLOUDFLARE_IPV4_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const;

const CLOUDFLARE_IPV6_CIDRS = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

export const CLOUDFLARE_CIDRS: readonly string[] = [
  ...CLOUDFLARE_IPV4_CIDRS,
  ...CLOUDFLARE_IPV6_CIDRS,
];

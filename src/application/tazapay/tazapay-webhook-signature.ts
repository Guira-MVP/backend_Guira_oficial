import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verificación de la firma de los webhooks de Tazapay
 * (documentacion tazapay/api-reference/appendix/webhook-authentication.md):
 *
 *   signature = Base64( HMAC-SHA256( secret, <event_id><payload><created_at> ) )
 *
 * - event_id: campo `id` del evento (evt_…).
 * - payload: el body crudo tal como llegó (sin re-serializar).
 * - created_at: el `created_at` de nivel superior (fuera de `data`).
 * - secret: Settings → Webhooks → secret token del dashboard.
 * La firma llega en el header `signature`.
 */
export function computeTazapaySignature(
  secret: string,
  eventId: string,
  rawBody: string,
  createdAt: string,
): string {
  return createHmac('sha256', secret)
    .update(`${eventId}${rawBody}${createdAt}`)
    .digest('base64');
}

export function verifyTazapaySignature(params: {
  secret: string;
  rawBody: Buffer | string;
  signatureHeader: string | null | undefined;
}): boolean {
  const { secret, signatureHeader } = params;
  if (!secret || !signatureHeader) return false;

  const raw =
    typeof params.rawBody === 'string'
      ? params.rawBody
      : params.rawBody.toString('utf8');
  let parsed: { id?: unknown; created_at?: unknown };
  try {
    parsed = JSON.parse(raw) as { id?: unknown; created_at?: unknown };
  } catch {
    return false;
  }
  if (typeof parsed.id !== 'string' || typeof parsed.created_at !== 'string')
    return false;

  const expected = Buffer.from(
    computeTazapaySignature(secret, parsed.id, raw, parsed.created_at),
  );
  const received = Buffer.from(signatureHeader.trim());
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

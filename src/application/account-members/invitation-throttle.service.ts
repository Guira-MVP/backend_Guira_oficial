import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';

/**
 * Límites de envío de invitaciones de equipo.
 *
 * El correo de invitación es el ÚNICO de la plataforma que un usuario puede
 * dirigir a un tercero que él elige: el de recuperación va a la propia
 * dirección, los de operaciones también. Eso lo convierte en la única
 * superficie que puede usarse como relay de correo, y por eso tiene
 * controles propios además del throttler global.
 *
 * Lo que se protege no es la disponibilidad del backend —el throttler
 * global ya topa las peticiones y un reenvío es un UPDATE barato— sino la
 * REPUTACIÓN DEL DOMINIO DE ENVÍO. Si el remitente transaccional se usa
 * para blasts, los proveedores lo marcan y dejan de llegar los correos de
 * recuperación de contraseña y de operaciones a todos los clientes. Es peor
 * que una caída: silencioso y lento de revertir.
 *
 * Se cuentan dos cubos por envío, siguiendo el mismo patrón que
 * `RateLimitGuard` adoptó para forgot-password tras su auditoría OWASP
 * (ver el comentario de `getIdentifiers` allí):
 *
 *  · Por CUENTA que invita — frena a un cliente que dispara en masa.
 *  · Por DESTINATARIO — frena el acoso a una dirección concreta, aunque
 *    venga repartido entre varias filas de invitación.
 *
 * Reutiliza la tabla `auth_rate_limits` con acciones propias, para que
 * todos los límites de la plataforma se inspeccionen en un solo sitio. NO
 * reutiliza `RateLimitGuard` a propósito: ese guard resuelve el
 * destinatario desde el cuerpo de la petición, y aquí la dirección vive en
 * la fila de invitación, que el guard no puede leer sin acoplarse a este
 * módulo.
 */

/** Cubos independientes; cada envío consume uno de cada. */
export const INVITE_THROTTLE_OWNER_ACTION = 'team_invite_owner';
export const INVITE_THROTTLE_RECIPIENT_ACTION = 'team_invite_recipient';

interface ThrottleRule {
  /** Envíos admitidos dentro de la ventana. */
  maxAttempts: number;
  windowMinutes: number;
  /** Cuánto se bloquea al superar el tope. */
  blockMinutes: number;
}

/**
 * Un cliente real invita a entre una y cinco personas, y reenvía alguna vez.
 * 10 por hora le sobra; a quien abusa le recorta el volumen unas mil veces
 * respecto a lo que permitiría solo un cooldown por fila.
 */
const OWNER_RULE: ThrottleRule = {
  maxAttempts: 10,
  windowMinutes: 60,
  blockMinutes: 60,
};

/**
 * Nadie necesita recibir la misma invitación más de tres veces en una hora.
 * Este es el cubo que impide usar el reenvío para machacar un buzón.
 */
const RECIPIENT_RULE: ThrottleRule = {
  maxAttempts: 3,
  windowMinutes: 60,
  blockMinutes: 60,
};

@Injectable()
export class InvitationThrottleService {
  private readonly logger = new Logger(InvitationThrottleService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  /**
   * Consume un envío de los dos cubos. Lanza 429 si alguno está agotado.
   *
   * Se comprueba ANTES de enviar y de tocar la fila: si el cupo está
   * agotado, no debe cambiar nada (ni el token, ni la fecha de caducidad),
   * o un cliente bloqueado invalidaría la invitación que ya mandó.
   */
  async consume(ownerId: string, recipientEmail: string): Promise<void> {
    await this.consumeBucket(
      ownerId,
      'owner',
      INVITE_THROTTLE_OWNER_ACTION,
      OWNER_RULE,
    );
    await this.consumeBucket(
      recipientEmail.trim().toLowerCase(),
      'email',
      INVITE_THROTTLE_RECIPIENT_ACTION,
      RECIPIENT_RULE,
    );
  }

  private async consumeBucket(
    identifier: string,
    identifierType: string,
    action: string,
    rule: ThrottleRule,
  ): Promise<void> {
    const now = new Date();

    // `maybeSingle` y no `single`: sin índice único sobre
    // (identifier, identifier_type, action), dos peticiones simultáneas
    // pueden dejar dos filas. Con `single` eso lanzaría un error de base de
    // datos en vez de aplicar el límite.
    const { data: existing, error } = await this.supabase
      .from('auth_rate_limits')
      .select('*')
      .eq('identifier', identifier)
      .eq('identifier_type', identifierType)
      .eq('action', action)
      .order('last_attempt_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      // Falla abierto A PROPÓSITO: este control protege la reputación del
      // dominio, no el acceso a datos. Dejar a un cliente sin poder invitar
      // porque la tabla de límites no respondió sería peor que permitir un
      // envío de más, y el throttler global sigue en pie.
      this.logger.error(
        `No se pudo consultar el límite de invitaciones (${action}): ${error.message}`,
      );
      return;
    }

    if (!existing) {
      await this.supabase.from('auth_rate_limits').insert({
        identifier,
        identifier_type: identifierType,
        action,
        attempt_count: 1,
        first_attempt_at: now.toISOString(),
        last_attempt_at: now.toISOString(),
      });
      return;
    }

    if (existing.blocked_until && new Date(existing.blocked_until) > now) {
      this.reject(new Date(existing.blocked_until), identifierType);
    }

    // Fuera de la ventana: el contador arranca de cero.
    const windowStart = new Date(now.getTime() - rule.windowMinutes * 60_000);
    if (
      !existing.first_attempt_at ||
      new Date(existing.first_attempt_at) < windowStart
    ) {
      await this.supabase
        .from('auth_rate_limits')
        .update({
          attempt_count: 1,
          first_attempt_at: now.toISOString(),
          last_attempt_at: now.toISOString(),
          blocked_until: null,
        })
        .eq('id', existing.id);
      return;
    }

    const nextCount = (existing.attempt_count ?? 0) + 1;

    if (nextCount > rule.maxAttempts) {
      const blockedUntil = new Date(
        now.getTime() + rule.blockMinutes * 60_000,
      );

      await this.supabase
        .from('auth_rate_limits')
        .update({
          attempt_count: nextCount,
          last_attempt_at: now.toISOString(),
          blocked_until: blockedUntil.toISOString(),
        })
        .eq('id', existing.id);

      this.logger.warn(
        `Límite de invitaciones alcanzado (${action}) por ${identifier}`,
      );
      this.reject(blockedUntil, identifierType);
    }

    await this.supabase
      .from('auth_rate_limits')
      .update({
        attempt_count: nextCount,
        last_attempt_at: now.toISOString(),
      })
      .eq('id', existing.id);
  }

  private reject(blockedUntil: Date, identifierType: string): never {
    const minutes = Math.max(
      1,
      Math.ceil((blockedUntil.getTime() - Date.now()) / 60_000),
    );

    // El mensaje distingue los dos cubos porque la acción correctiva es
    // distinta: con el de cuenta hay que esperar; con el de destinatario,
    // además, conviene confirmar que la dirección es la correcta.
    const message =
      identifierType === 'email'
        ? `Ya se enviaron varias invitaciones a esa dirección. Podrás volver a intentarlo en ${minutes} minuto(s).`
        : `Enviaste demasiadas invitaciones seguidas. Podrás volver a intentarlo en ${minutes} minuto(s).`;

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message,
        retryAfter: minutes,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

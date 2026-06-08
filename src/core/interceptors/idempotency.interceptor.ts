import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../supabase/supabase.module';

/**
 * IdempotencyInterceptor — prevents duplicate resource creation on POST endpoints.
 *
 * How it works:
 * 1. Client sends `Idempotency-Key` header with a client-generated UUID.
 * 2. Before executing the handler, we check `idempotency_keys` table.
 *    - If the key already exists and hasn't expired → return the cached response.
 *    - If it doesn't exist → proceed with the handler and cache the response.
 * 3. The unique constraint `(user_id, idempotency_key)` in the DB provides a
 *    second layer of protection against race conditions.
 *
 * This interceptor only activates for POST requests that include the header.
 * If the header is missing, the request proceeds normally (backward compatible).
 *
 * Apply it per-controller or per-handler using @UseInterceptors(IdempotencyInterceptor).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Only intercept POST requests
    if (request.method !== 'POST') {
      return next.handle();
    }

    const idempotencyKey = request.headers['idempotency-key'] as
      | string
      | undefined;

    // No header → proceed normally (backward compatible)
    if (!idempotencyKey) {
      return next.handle();
    }

    // BAJO-02: Validación estricta de UUID v4 (RFC 4122).
    // El check anterior (/^[0-9a-f\-]{36}$/i) solo verificaba longitud y
    // alfabeto, aceptando cadenas estructuralmente inválidas (ej. 36 guiones).
    // Esto valida agrupación 8-4-4-4-12, nibble de versión "4" y bits de
    // variante correctos — el formato real que generan uuid v4 (crypto.randomUUID).
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        idempotencyKey,
      )
    ) {
      throw new HttpException(
        'Idempotency-Key debe ser un UUID v4 válido',
        HttpStatus.BAD_REQUEST,
      );
    }

    const userId = request.user?.id as string | undefined;
    if (!userId) {
      // If the user is not authenticated, skip idempotency (the auth guard will
      // reject the request anyway)
      return next.handle();
    }

    const endpoint = `${request.method} ${request.route?.path ?? request.url}`;

    // 1. Check if the key already exists
    const { data: existing } = await this.supabase
      .from('idempotency_keys')
      .select('response_status, response_body')
      .eq('user_id', userId)
      .eq('idempotency_key', idempotencyKey)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (existing) {
      this.logger.log(
        `♻️ Idempotent replay: user=${userId.slice(0, 8)} key=${idempotencyKey.slice(0, 8)} endpoint=${endpoint}`,
      );
      response.status(existing.response_status);
      return of(existing.response_body);
    }

    // 2. Try to insert the key first (lock) — prevents race conditions
    //    If two concurrent requests arrive with the same key, only one will succeed
    //    thanks to the UNIQUE constraint (user_id, idempotency_key).
    const { error: insertError } = await this.supabase
      .from('idempotency_keys')
      .insert({
        user_id: userId,
        idempotency_key: idempotencyKey,
        endpoint,
        response_status: 0, // Placeholder — will be updated after handler completes
        response_body: {},
      });

    if (insertError) {
      // Unique constraint violation → another request with the same key is in progress
      // or was just completed. Re-fetch and return the cached response.
      if (insertError.code === '23505') {
        this.logger.log(
          `🔒 Idempotent conflict (concurrent): user=${userId.slice(0, 8)} key=${idempotencyKey.slice(0, 8)}`,
        );

        // Brief wait for the other request to finish writing the response
        await new Promise((resolve) => setTimeout(resolve, 500));

        const { data: retry } = await this.supabase
          .from('idempotency_keys')
          .select('response_status, response_body')
          .eq('user_id', userId)
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();

        if (retry && retry.response_status > 0) {
          response.status(retry.response_status);
          return of(retry.response_body);
        }

        // The other request hasn't finished yet — return 409 to signal retry
        throw new HttpException(
          'Solicitud en proceso. Espera un momento e intenta nuevamente.',
          HttpStatus.CONFLICT,
        );
      }

      // Other DB error — log and proceed without idempotency
      this.logger.warn(
        `Idempotency insert failed (non-unique): ${insertError.message}`,
      );
      return next.handle();
    }

    // 3. Execute the handler and cache the result
    return next.handle().pipe(
      tap(async (responseBody) => {
        try {
          await this.supabase
            .from('idempotency_keys')
            .update({
              response_status: response.statusCode || 201,
              response_body: responseBody,
            })
            .eq('user_id', userId)
            .eq('idempotency_key', idempotencyKey);
        } catch (err) {
          this.logger.warn(
            `Failed to cache idempotency response: ${(err as Error).message}`,
          );
        }
      }),
      catchError((err) => {
        // On error, delete the key so the client can retry with the same key
        void this.supabase
          .from('idempotency_keys')
          .delete()
          .eq('user_id', userId)
          .eq('idempotency_key', idempotencyKey)
          .then(() => {}); // Fire-and-forget cleanup

        return throwError(() => err);
      }),
    );
  }
}

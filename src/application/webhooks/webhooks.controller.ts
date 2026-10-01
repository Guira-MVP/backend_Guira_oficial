import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { verifyTazapaySignature } from '../tazapay/tazapay-webhook-signature';
import { Public } from '../../core/guards/supabase-auth.guard';
import { WebhooksService } from './webhooks.service';

// Extensión del tipo Request de Express para incluir el rawBody capturado en main.ts
type RequestWithRawBody = Request & { rawBody?: Buffer };

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Endpoint receptor de webhooks de Bridge.
   * Es PÚBLICO (no requiere JWT de usuario).
   *
   * Flujo:
   * 1. Recibe el evento con el raw body capturado en main.ts
   * 2. Persiste el evento en webhook_events con status 'pending'
   * 3. Responde 200 inmediatamente (Bridge reintenta si no recibe 200 rápido)
   * 4. El CRON worker procesa la cola async cada 30s
   *
   * Header de firma de Bridge: X-Webhook-Signature: t=<timestamp>,v0=<base64sig>
   */
  @Public()
  @Throttle({ default: { limit: 1000, ttl: 60000 } }) // Permite ráfagas del proveedor (1000/min)
  @Post('bridge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receptor de webhooks Bridge (Webhook Sink)' })
  @ApiExcludeEndpoint()
  async receiveBridgeWebhook(
    @Req() req: RequestWithRawBody,
    @Headers('x-webhook-signature') signatureHeader: string,
    @Headers('bridge-api-version') apiVersion: string,
  ) {
    const payload = req.body as Record<string, unknown>;
    // El rawBody (Buffer) es requerido para verificar la firma RSA/SHA256 de Bridge.
    // Se captura en el middleware de main.ts antes del JSON parsing.
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(payload));

    // Bridge envía el event ID en "event_id" y el tipo en "event_type" (no "id"/"type")
    const providerEventId = (payload?.event_id as string) ?? null;
    const eventType = (payload?.event_type as string) ?? 'unknown';

    this.logger.log(
      `📨 Bridge webhook recibido: ${eventType} (${providerEventId})`,
    );

    await this.webhooksService.sinkEvent({
      provider: 'bridge',
      event_type: eventType,
      provider_event_id: providerEventId,
      raw_payload: payload,
      raw_body: rawBody,
      headers: {
        'x-webhook-signature': signatureHeader ?? null,
        'bridge-api-version': apiVersion ?? null,
      },
      bridge_api_version: apiVersion ?? null,
    });

    return { received: true };
  }

  /**
   * Endpoint receptor de webhooks de Tazapay (configurado en el dashboard:
   * Settings → Webhooks, una URL por cuenta: sandbox → staging, live → prod).
   * Es PÚBLICO. La firma HMAC-SHA256 (header `signature`) se verifica aquí
   * con el body crudo y TAZAPAY_WEBHOOK_SECRET; el evento se guarda con
   * provider='tazapay' y lo procesa el mismo worker que los de Bridge.
   * Tazapay reintenta durante 24 h si no recibe 2xx.
   */
  @Public()
  @Throttle({ default: { limit: 1000, ttl: 60000 } })
  @Post('tazapay')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receptor de webhooks Tazapay' })
  @ApiExcludeEndpoint()
  async receiveTazapayWebhook(
    @Req() req: RequestWithRawBody,
    @Headers('signature') signatureHeader: string,
  ) {
    const payload = (req.body ?? {}) as Record<string, unknown>;
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(payload));
    const providerEventId = typeof payload.id === 'string' ? payload.id : null;
    const eventType = typeof payload.type === 'string' ? payload.type : 'unknown';

    const signatureVerified = verifyTazapaySignature({
      secret: this.config.get<string>('app.tazapayWebhookSecret') ?? '',
      rawBody,
      signatureHeader,
    });

    this.logger.log(`📨 Tazapay webhook recibido: ${eventType} (${providerEventId})`);

    await this.webhooksService.sinkEvent({
      provider: 'tazapay',
      event_type: eventType,
      provider_event_id: providerEventId,
      raw_payload: payload,
      raw_body: rawBody,
      headers: { signature: signatureHeader ?? null },
      bridge_api_version: null,
      signature_verified: signatureVerified,
    });

    return { received: true };
  }
}

import { Injectable, BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cliente HTTP centralizado y tipado para Bridge API v0.
 * Todas las llamadas a Bridge pasan por aquí.
 */
@Injectable()
export class BridgeApiClient {
  private readonly logger = new Logger(BridgeApiClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    const rawUrl =
      config.get<string>('app.bridgeApiUrl') ?? 'https://api.bridge.xyz';
    // Normalizar: quitar /v0 al final si el env var lo incluye.
    // Los paths internos ya incluyen /v0/... de forma explícita.
    this.baseUrl = rawUrl.replace(/\/v0\/?$/, '');
    this.apiKey = config.get<string>('app.bridgeApiKey') ?? '';
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Api-Key': this.apiKey,
    };
  }

  /**
   * Redacta datos bancarios/PII antes de loguear un error de Bridge.
   * Bridge a veces ecoa el payload enviado en sus mensajes de validación
   * (ej. "invalid routing_number: 123456789"), lo que dejaría cuentas
   * bancarias, IBAN, CLABE, etc. en texto plano en los logs del servidor.
   */
  private redactSensitiveError(rawBody: string): string {
    const sensitiveKeys = [
      'account_number',
      'routing_number',
      'iban',
      'clabe',
      'pix_key',
      'br_code',
      'bre_b_key',
      'swift_bic',
      'wallet_address',
      'document_number',
      'phone_number',
      'sort_code',
      'bank_code',
    ];

    let redacted = rawBody;
    for (const key of sensitiveKeys) {
      // Cubre tanto JSON ("key":"value") como texto libre (key: value / key=value)
      const jsonPattern = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, 'gi');
      const freeformPattern = new RegExp(`(\\b${key}\\b\\s*[:=]\\s*)[^\\s,"}]+`, 'gi');
      redacted = redacted
        .replace(jsonPattern, '$1"[REDACTED]"')
        .replace(freeformPattern, '$1[REDACTED]');
    }

    return redacted.length > 2000 ? `${redacted.slice(0, 2000)}...[truncated]` : redacted;
  }

  async post<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    this.ensureConfigured();

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.headers,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Bridge POST ${path} failed [${res.status}]: ${this.redactSensitiveError(err)}`);
      // ALTO-02: No propagar el cuerpo crudo del error de Bridge al cliente
      // (puede contener IDs internos, datos KYC o detalles de arquitectura).
      // El detalle completo queda en logger.error de arriba para debugging.
      throw new BadGatewayException(
        'Error al procesar la operación con el proveedor financiero. Inténtalo de nuevo o contacta a soporte si el problema persiste.',
      );
    }

    return res.json() as Promise<T>;
  }

  async get<T = Record<string, unknown>>(path: string): Promise<T> {
    this.ensureConfigured();

    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers,
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Bridge GET ${path} failed [${res.status}]: ${this.redactSensitiveError(err)}`);
      // ALTO-02: No propagar el cuerpo crudo del error de Bridge al cliente
      // (puede contener IDs internos, datos KYC o detalles de arquitectura).
      // El detalle completo queda en logger.error de arriba para debugging.
      throw new BadGatewayException(
        'Error al procesar la operación con el proveedor financiero. Inténtalo de nuevo o contacta a soporte si el problema persiste.',
      );
    }

    return res.json() as Promise<T>;
  }

  async put<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    this.ensureConfigured();

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        ...this.headers,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Bridge PUT ${path} failed [${res.status}]: ${this.redactSensitiveError(err)}`);
      // ALTO-02: No propagar el cuerpo crudo del error de Bridge al cliente
      // (puede contener IDs internos, datos KYC o detalles de arquitectura).
      // El detalle completo queda en logger.error de arriba para debugging.
      throw new BadGatewayException(
        'Error al procesar la operación con el proveedor financiero. Inténtalo de nuevo o contacta a soporte si el problema persiste.',
      );
    }

    return res.json() as Promise<T>;
  }

  async delete<T = Record<string, unknown>>(path: string): Promise<T> {
    this.ensureConfigured();

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.headers,
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Bridge DELETE ${path} failed [${res.status}]: ${this.redactSensitiveError(err)}`);
      // ALTO-02: No propagar el cuerpo crudo del error de Bridge al cliente
      // (puede contener IDs internos, datos KYC o detalles de arquitectura).
      // El detalle completo queda en logger.error de arriba para debugging.
      throw new BadGatewayException(
        'Error al procesar la operación con el proveedor financiero. Inténtalo de nuevo o contacta a soporte si el problema persiste.',
      );
    }

    return res.json() as Promise<T>;
  }

  private ensureConfigured(): void {
    if (!this.apiKey) {
      this.logger.warn('BRIDGE_API_KEY no configurada');
      throw new BadGatewayException(
        'Bridge API no configurada. Contacte al administrador.',
      );
    }
  }
}

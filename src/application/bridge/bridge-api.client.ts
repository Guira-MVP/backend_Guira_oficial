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
      this.logger.error(`Bridge POST ${path} failed [${res.status}]: ${err}`);
      throw new BadGatewayException(`Bridge API error [${res.status}]: ${err}`);
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
      this.logger.error(`Bridge GET ${path} failed [${res.status}]: ${err}`);
      throw new BadGatewayException(`Bridge API error [${res.status}]: ${err}`);
    }

    return res.json() as Promise<T>;
  }

  async put<T = Record<string, unknown>>(
    path: string,
    body: unknown,
  ): Promise<T> {
    this.ensureConfigured();

    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`Bridge PUT ${path} failed [${res.status}]: ${err}`);
      throw new BadGatewayException(`Bridge API error [${res.status}]: ${err}`);
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
      this.logger.error(`Bridge DELETE ${path} failed [${res.status}]: ${err}`);
      throw new BadGatewayException(`Bridge API error [${res.status}]: ${err}`);
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

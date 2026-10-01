import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Error de una llamada a Tazapay. `retryable` distingue fallas técnicas
 * (timeout, 5xx, 429) de rechazos de validación (4xx), que no se reintentan
 * automáticamente. `providerMessage` va REDACTADO: Tazapay ecoa datos del
 * payload en sus errores de validación.
 */
export class TazapayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
    public readonly providerMessage: string | null,
  ) {
    super(message);
    this.name = 'TazapayApiError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SENSITIVE_KEYS = [
  'number',
  'tax_id',
  'registration_number',
  'account_number',
  'iban',
  'phone',
  'email',
  'date_of_birth',
  'url',
];

/**
 * Cliente HTTP de Tazapay (API v3). Autenticación Basic: API Key como
 * usuario y API Secret como contraseña. Sandbox y producción se distinguen
 * por la URL y por las keys (TAZAPAY_API_URL, TAZAPAY_API_KEY/SECRET).
 */
@Injectable()
export class TazapayApiClient {
  private readonly logger = new Logger(TazapayApiClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor(config: ConfigService) {
    const rawUrl =
      config.get<string>('app.tazapayApiUrl') ||
      'https://service-sandbox.tazapay.com';
    this.baseUrl = rawUrl.replace(/\/+$/, '');
    this.apiKey = config.get<string>('app.tazapayApiKey') ?? '';
    this.apiSecret = config.get<string>('app.tazapayApiSecret') ?? '';
  }

  get isConfigured(): boolean {
    return !!this.apiKey && !!this.apiSecret;
  }

  async post<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    return this.request<T>('POST', path, body, idempotencyKey);
  }

  async put<T = Record<string, unknown>>(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    return this.request<T>('PUT', path, body, idempotencyKey);
  }

  async get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /**
   * Sube bytes a la URL presignada de S3 que devuelve
   * POST /v3/metadata/doc/upload. No lleva credenciales de Tazapay.
   */
  async uploadToPresignedUrl(
    url: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void> {
    const res = await this.fetchWithTimeout(url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      throw new TazapayApiError(
        `Subida del documento a Tazapay falló [${res.status}]`,
        res.status,
        res.status >= 500 || res.status === 429,
        null,
      );
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    if (!this.isConfigured) {
      throw new TazapayApiError(
        'Tazapay no está configurado (TAZAPAY_API_KEY / TAZAPAY_API_SECRET)',
        null,
        false,
        null,
      );
    }

    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64')}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new TazapayApiError(
        `Tazapay ${method} ${path} sin respuesta: ${(err as Error).message}`,
        null,
        true,
        null,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      const redacted = TazapayApiClient.redact(text);
      this.logger.error(
        `Tazapay ${method} ${path} falló [${res.status}]: ${redacted}`,
      );
      throw new TazapayApiError(
        `Tazapay ${method} ${path} falló [${res.status}]`,
        res.status,
        res.status >= 500 || res.status === 429,
        redacted,
      );
    }

    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TazapayApiError(
        `Tazapay ${method} ${path}: respuesta no es JSON`,
        res.status,
        true,
        null,
      );
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Redacta valores sensibles que Tazapay pueda ecoar en un error. */
  static redact(raw: string): string {
    let out = raw;
    for (const key of SENSITIVE_KEYS) {
      out = out.replace(
        new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`, 'gi'),
        '$1"[REDACTED]"',
      );
    }
    out = out.replace(/https?:\/\/[^\s"]+/g, '[URL]');
    return out.length > 2000 ? `${out.slice(0, 2000)}...[truncated]` : out;
  }
}

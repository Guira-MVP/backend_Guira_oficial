import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ZeptoMailAddress,
  ZeptoMailSendRequest,
  ZeptoMailSuccessResponse,
} from './zeptomail.types';

const ZEPTOMAIL_TOKEN_PREFIX = 'zoho-enczapikey';
const ZEPTOMAIL_TIMEOUT_MS = 10_000;

/**
 * Cliente HTTP de bajo nivel para la API de envío de ZeptoMail.
 * Lanza Error simple en fallos — EmailService decide cómo manejarlo.
 */
@Injectable()
export class ZeptoMailClient {
  private readonly logger = new Logger(ZeptoMailClient.name);
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fromAddress: string;
  private readonly fromName: string;

  constructor(private readonly config: ConfigService) {
    this.apiUrl =
      this.config.get<string>('app.zeptoMailApiUrl') ??
      'https://api.zeptomail.com/v1.1/email';
    this.token = this.normalizeToken(
      this.config.get<string>('app.zeptoMailToken') ?? '',
    );
    this.fromAddress = this.config.get<string>('app.emailFromAddress') ?? '';
    this.fromName = this.config.get<string>('app.emailFromName') ?? 'Guira';
  }

  get isConfigured(): boolean {
    return !!this.token && !!this.fromAddress;
  }

  // El dashboard de Zoho a veces entrega el token ya con el prefijo
  // "Zoho-enczapikey " incluido. Lo normalizamos para que el header
  // Authorization quede bien formado en ambos casos.
  private normalizeToken(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase().startsWith(ZEPTOMAIL_TOKEN_PREFIX)) {
      return trimmed.slice(ZEPTOMAIL_TOKEN_PREFIX.length).trim();
    }
    return trimmed;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Zoho-enczapikey ${this.token}`,
    };
  }

  private get defaultFrom(): ZeptoMailAddress {
    return { address: this.fromAddress, name: this.fromName };
  }

  async send(
    payload: Omit<ZeptoMailSendRequest, 'from'> & {
      from?: ZeptoMailAddress;
    },
  ): Promise<ZeptoMailSuccessResponse> {
    this.ensureConfigured();

    const body: ZeptoMailSendRequest = {
      ...payload,
      from: payload.from ?? this.defaultFrom,
    };

    let res: Response;
    try {
      res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ZEPTOMAIL_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`ZeptoMail request falló: ${(err as Error).message}`);
      throw new Error('ZeptoMail request falló');
    }

    if (!res.ok) {
      const err = await res.text();
      this.logger.error(`ZeptoMail send falló [${res.status}]: ${err}`);
      throw new Error(`ZeptoMail respondió con estado ${res.status}`);
    }

    return res.json() as Promise<ZeptoMailSuccessResponse>;
  }

  private ensureConfigured(): void {
    if (!this.isConfigured) {
      this.logger.warn('ZEPTOMAIL_TOKEN o EMAIL_FROM_ADDRESS no configurados');
      throw new Error('ZeptoMail no configurado');
    }
  }
}

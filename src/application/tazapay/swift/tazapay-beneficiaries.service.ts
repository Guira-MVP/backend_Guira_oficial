import { Injectable, Logger } from '@nestjs/common';
import { TazapayApiClient, TazapayApiError } from '../tazapay-api.client';
import { BeneficiaryType } from './tazapay-corridor.service';

export interface SwiftBeneficiaryInput {
  userId: string;
  supplierId: string;
  name: string;
  beneficiaryType: BeneficiaryType;
  country: string;
  currency: string;
  /** Valores ya validados y normalizados, con claves del diccionario. */
  values: Record<string, string>;
}

export interface TazapayBeneficiaryResponse {
  id: string;
  destination: string | null;
  raw: Record<string, unknown>;
}

export interface TazapayBankSearchResult {
  bank_name: string;
  swift_code: string | null;
  country: string | null;
  address: string | null;
}

export interface MappedTazapayError {
  /** 4xx de validación: el alta no se hizo y no se va a hacer reintentando. */
  isValidation: boolean;
  /** Falla técnica: reintentar con la misma idempotency key. */
  retryable: boolean;
  /** Tazapay dice que faltan campos: la metadata cacheada puede estar vieja. */
  invalidateCorridor: boolean;
  code: string | null;
  message: string;
  field: string | null;
}

/** Códigos del apéndice "Create Beneficiary" → campo y mensaje en español. */
const ERROR_MAP: Record<string, { field: string | null; message: string }> = {
  '20150': {
    field: 'name',
    message: 'El nombre del beneficiario no es válido.',
  },
  '20151': {
    field: 'email',
    message: 'El email del beneficiario no es válido.',
  },
  '20152': {
    field: 'beneficiary_type',
    message: 'El tipo de beneficiario no es válido.',
  },
  '20153': { field: null, message: 'Los datos bancarios no son válidos.' },
  '20154': {
    field: 'bank.bank_name',
    message: 'El nombre del banco no es válido.',
  },
  '20155': {
    field: 'bank_country',
    message: 'El país del banco no es válido.',
  },
  '20156': {
    field: 'currency',
    message: 'La moneda no es válida para este destino.',
  },
  '20157': {
    field: 'bank_codes.swift_code',
    message: 'Los códigos bancarios no son válidos.',
  },
  '20159': {
    field: null,
    message:
      'Los pagos bancarios están deshabilitados temporalmente en el proveedor.',
  },
  '20320': {
    field: null,
    message: 'Faltan datos bancarios que exige el banco destino.',
  },
  '20321': {
    field: null,
    message: 'Faltan datos bancarios que exige el banco destino.',
  },
  '20322': {
    field: 'bank_codes.swift_code',
    message: 'Faltan o no son válidos los datos SWIFT del banco destino.',
  },
  '20326': { field: null, message: 'Algunos datos bancarios no son válidos.' },
  '20361': {
    field: null,
    message: 'Faltan datos del beneficiario que exige el destino.',
  },
  '3895': {
    field: 'bank.account_number',
    message: 'El número de cuenta es obligatorio.',
  },
  '3896': {
    field: 'bank.account_number',
    message: 'El número de cuenta debe tener entre 4 y 34 letras o números.',
  },
  '3910': {
    field: 'bank_codes.swift_code',
    message: 'El código SWIFT es obligatorio.',
  },
  '3911': {
    field: 'bank_codes.swift_code',
    message: 'El código SWIFT debe tener 8 u 11 caracteres.',
  },
  '3912': {
    field: 'bank_codes.swift_code',
    message:
      'El código de localidad del SWIFT (caracteres 7 y 8) no es válido.',
  },
  '3913': {
    field: 'bank_codes.swift_code',
    message: 'El país del código SWIFT no está soportado.',
  },
};
for (const code of [
  '3900',
  '3901',
  '3902',
  '3903',
  '3904',
  '3905',
  '3906',
  '3907',
]) {
  ERROR_MAP[code] = { field: 'bank.iban', message: 'El IBAN no es válido.' };
}

const MISSING_FIELD_CODES = new Set(['20320', '20321', '20322', '20361']);

/**
 * Llamadas de beneficiarios a Tazapay: búsqueda de bancos, alta y edición.
 * No guarda nada en la DB: eso lo hace SwiftSuppliersService.
 */
@Injectable()
export class TazapayBeneficiariesService {
  private readonly logger = new Logger(TazapayBeneficiariesService.name);

  constructor(private readonly client: TazapayApiClient) {}

  get isConfigured(): boolean {
    return this.client.isConfigured;
  }

  /** Buscador de bancos por SWIFT o por nombre (mín. 3 caracteres). */
  async searchBanks(
    country: string,
    query: string,
  ): Promise<TazapayBankSearchResult[]> {
    const text = query.trim();
    if (text.length < 3) return [];
    const looksLikeSwift = /^[A-Za-z]{6}[A-Za-z0-9]{0,5}$/.test(text);
    const codeType = looksLikeSwift ? 'swift_code' : 'bank_name';
    const params = new URLSearchParams({
      country: country.toUpperCase(),
      code_type: codeType,
      search_text: looksLikeSwift ? text.toUpperCase() : text,
      limit: '10',
    });
    const response = await this.client.get<{
      data?: { results?: Array<Record<string, any>> };
    }>(`/v3/payout/bank?${params.toString()}`);
    return (response.data?.results ?? []).map((r) => ({
      bank_name: String(r.bank_name ?? ''),
      swift_code: (r.bank_codes?.swift_code as string) ?? null,
      country: (r.country_code as string) ?? null,
      address: typeof r.address === 'string' ? r.address : null,
    }));
  }

  /** Arma el body de POST /v3/beneficiary a partir de los campos del diccionario. */
  buildPayload(input: SwiftBeneficiaryInput): Record<string, unknown> {
    const bank: Record<string, unknown> = {
      country: input.country.toUpperCase(),
      currency: input.currency.toUpperCase(),
      transfer_type: 'swift',
    };
    const bankCodes: Record<string, string> = {};
    const address: Record<string, string> = {};
    const phone: Record<string, string> = {};
    const top: Record<string, string> = {};

    for (const [key, value] of Object.entries(input.values)) {
      if (!value) continue;
      const [head, ...rest] = key.split('.');
      const sub = rest.join('.');
      if (head === 'bank' && sub) bank[sub] = value;
      else if (head === 'bank_codes' && sub) bankCodes[sub] = value;
      else if (head === 'address' && sub) address[sub] = value;
      else if (head === 'phone' && sub) phone[sub] = value;
      else if (key === 'date_of_birth') top[key] = this.toTazapayDate(value);
      else top[key] = value;
    }

    if (Object.keys(bankCodes).length > 0) bank.bank_codes = bankCodes;
    if (Object.keys(address).length > 0 && !address.country) {
      address.country = input.country.toUpperCase();
    }
    if (phone.calling_code)
      phone.calling_code = phone.calling_code.replace(/^\+/, '');

    return {
      name: input.name.slice(0, 140),
      type: input.beneficiaryType,
      ...top,
      ...(Object.keys(address).length > 0 ? { address } : {}),
      ...(phone.number ? { phone } : {}),
      // Tazapay documenta metadata como string JSON.
      metadata: JSON.stringify({
        guira_user_id: input.userId,
        guira_supplier_id: input.supplierId,
      }),
      destination_details: { type: 'bank', bank },
    };
  }

  async create(
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<TazapayBeneficiaryResponse> {
    const response = await this.client.post<{
      status?: string;
      data?: Record<string, unknown>;
    }>('/v3/beneficiary', payload, idempotencyKey);
    const data = response.data ?? {};
    const id = typeof data.id === 'string' ? data.id : null;
    if (!id) {
      throw new TazapayApiError(
        'Tazapay respondió al alta del beneficiario sin id',
        null,
        true,
        null,
      );
    }
    return {
      id,
      destination:
        typeof data.destination === 'string' ? data.destination : null,
      raw: data,
    };
  }

  async update(
    beneficiaryId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.client.put(
      `/v3/beneficiary/${encodeURIComponent(beneficiaryId)}`,
      payload,
    );
  }

  /** Traduce un error de Tazapay a algo que se pueda mostrar al cliente. */
  mapError(err: unknown): MappedTazapayError {
    if (!(err instanceof TazapayApiError)) {
      return {
        isValidation: false,
        retryable: true,
        invalidateCorridor: false,
        code: null,
        message: 'No pudimos comunicarnos con el proveedor.',
        field: null,
      };
    }

    const providerErrors = this.parseProviderErrors(err.providerMessage);
    const first =
      providerErrors.find((e) => e.code && ERROR_MAP[e.code]) ??
      providerErrors[0];
    const mapped = first?.code ? ERROR_MAP[first.code] : undefined;
    const detail = first?.message ? this.extractFieldList(first.message) : null;

    const isValidation =
      !err.retryable && err.status !== null && err.status < 500;
    let message =
      mapped?.message ?? 'El proveedor rechazó los datos del beneficiario.';
    if (detail && first?.code && MISSING_FIELD_CODES.has(first.code)) {
      message = `${message} (${detail})`;
    }
    if (!isValidation) {
      message = 'No pudimos comunicarnos con el proveedor.';
    }

    return {
      isValidation,
      retryable: err.retryable,
      invalidateCorridor: providerErrors.some(
        (e) => e.code && MISSING_FIELD_CODES.has(e.code),
      ),
      code: first?.code ?? (err.status ? String(err.status) : null),
      message,
      field: mapped?.field ?? null,
    };
  }

  /** Copia del payload sin identificadores completos, para guardar en la DB. */
  redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const clone = JSON.parse(JSON.stringify(payload)) as Record<string, any>;
    const mask = (v: unknown) =>
      typeof v === 'string' && v.length > 0 ? `****${v.slice(-4)}` : v;
    const bank = clone.destination_details?.bank;
    if (bank) {
      bank.account_number = mask(bank.account_number);
      bank.iban = mask(bank.iban);
    }
    if (clone.phone) clone.phone.number = mask(clone.phone.number);
    for (const key of [
      'tax_id',
      'national_identification_number',
      'date_of_birth',
      'email',
    ]) {
      if (clone[key]) clone[key] = '[REDACTED]';
    }
    return clone;
  }

  /** Respuesta de Tazapay sin identificadores completos. */
  redactResponse(raw: Record<string, unknown>): Record<string, unknown> {
    try {
      return JSON.parse(TazapayApiClient.redact(JSON.stringify(raw))) as Record<
        string,
        unknown
      >;
    } catch {
      return {};
    }
  }

  private parseProviderErrors(
    providerMessage: string | null,
  ): Array<{ code: string | null; message: string | null }> {
    if (!providerMessage) return [];
    try {
      const body = JSON.parse(providerMessage) as {
        errors?: Array<{ code?: unknown; message?: unknown }>;
        message?: unknown;
      };
      const list = Array.isArray(body.errors) ? body.errors : [];
      if (list.length === 0 && typeof body.message === 'string') {
        return [{ code: null, message: body.message }];
      }
      return list.map((e) => ({
        code:
          typeof e.code === 'string' || typeof e.code === 'number'
            ? String(e.code)
            : null,
        message: typeof e.message === 'string' ? e.message : null,
      }));
    } catch {
      return [];
    }
  }

  /** Mensajes tipo "...: account_holder_name, bank_name" → "account_holder_name, bank_name". */
  private extractFieldList(message: string): string | null {
    const idx = message.lastIndexOf(':');
    if (idx < 0) return null;
    const list = message.slice(idx + 1).trim();
    return list && list.length <= 200 ? list : null;
  }

  /** YYYY-MM-DD (input de fecha) → DD-MM-YYYY (formato de Tazapay). */
  private toTazapayDate(value: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : value;
  }
}

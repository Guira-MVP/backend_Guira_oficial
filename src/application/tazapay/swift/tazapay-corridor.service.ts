import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';
import { TazapayApiClient, TazapayApiError } from '../tazapay-api.client';
import {
  SWIFT_BASE_REQUIRED_KEYS,
  SWIFT_FIELD_DICTIONARY,
  SWIFT_FIELD_GROUP_ORDER,
  SWIFT_FIELD_ORDER,
  SwiftFieldControl,
  SwiftFieldGroup,
  fallbackLabel,
  isValidIbanChecksum,
  metadataKeyToDictionaryKeys,
  normalizeSwiftValue,
  ruleKeyToDictionaryKeys,
} from './tazapay-field-dictionary';
import { TazapaySwiftEligibilityService } from './tazapay-swift-eligibility.service';

const CACHE_TTL_MS = 24 * 3600_000;
const PAYOUT_TYPE = 'swift';
const UNKNOWN_FIELD_MAX_LENGTH = 140;

/** Campos que se ofrecen siempre como opcionales aunque la metadata no los liste. */
const BASE_OPTIONAL_KEYS = [
  'address.line1',
  'address.city',
  'address.state',
  'address.postal_code',
  'address.country',
];

/** Grupo "uno de dos": Tazapay acepta número de cuenta O IBAN. */
const ACCOUNT_ONE_OF_GROUP = 'account_identifier';

export type BeneficiaryType = 'individual' | 'business';

interface TransferLimit {
  currency?: string;
  minimum?: number;
  maximum?: number;
}

interface CutoffSchedule {
  timezone?: string;
  days?: Record<string, { open?: string; close?: string }>;
}

interface CapabilityFields {
  transfer_limit?: TransferLimit | null;
  delivery_time?: string | null;
  supported_modes?: string[] | null;
  restricted_purpose_codes?: string[] | null;
  cutoff_schedule?: CutoffSchedule | null;
  on_behalf_of_supported?: boolean | null;
}

export interface TazapayPayoutMethod extends CapabilityFields {
  payout_type?: string;
  country?: string;
  currency?: string;
  beneficiary_type?: string[];
  required_bank_codes?: string[];
  required_bank_fields?: string[];
  required_beneficiary_fields?: string[];
  recommended_fields?: {
    recommended_bank_codes?: string[];
    recommended_bank_fields?: string[];
    recommended_beneficiary_fields?: string[];
  };
  fund_transfer_networks?: Array<CapabilityFields & { name?: string }>;
}

interface CorridorRule {
  country: string;
  currency: string | null;
  beneficiary_type: string | null;
  rule_type:
    | 'require_field'
    | 'recommend_field'
    | 'field_pattern'
    | 'allowed_swift_prefixes'
    | 'blocked_swift_codes'
    | 'payout_requirement'
    | 'notice';
  field_key: string | null;
  value: Record<string, unknown> | null;
  message_es: string | null;
}

export interface SwiftSchemaField {
  key: string;
  label: string;
  control: SwiftFieldControl;
  group: SwiftFieldGroup;
  required: boolean;
  recommended: boolean;
  maxLength: number;
  pattern?: string;
  patternMessage?: string;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  help?: string;
  defaultValue?: string;
  /** Si viene, basta con llenar uno de los campos del grupo. */
  oneOfGroup?: string;
  /** false = clave que la metadata pidió y no está en el diccionario. */
  known: boolean;
}

export interface SwiftCorridorInfo {
  network: string | null;
  transfer_limit: TransferLimit | null;
  delivery_time: string | null;
  cutoff_schedule: CutoffSchedule | null;
  supported_modes: string[];
  restricted_purpose_codes: string[];
}

export type SwiftUnavailableReason =
  | 'CORRIDOR_NOT_AVAILABLE'
  | 'CURRENCY_NOT_ALLOWED'
  | 'MODE_NOT_SUPPORTED'
  | 'BENEFICIARY_TYPE_NOT_SUPPORTED'
  | 'PROVIDER_UNAVAILABLE';

export type SwiftFormSchema =
  | {
      available: true;
      country: string;
      currency: string;
      beneficiary_type: BeneficiaryType | null;
      beneficiary_types: BeneficiaryType[];
      fields: SwiftSchemaField[];
      bank_rules: {
        blocked_swift_codes: string[];
        allowed_swift_prefixes: string[];
      };
      notices: string[];
      corridor: SwiftCorridorInfo;
      stale: boolean;
    }
  | {
      available: false;
      country: string;
      currency: string;
      reason: SwiftUnavailableReason;
      message: string;
    };

export interface SwiftCurrencyOption {
  currency: string;
  delivery_time: string | null;
  transfer_limit: TransferLimit | null;
}

export interface SwiftValidationError {
  field: string;
  message: string;
}

export interface SwiftValidationResult {
  values: Record<string, string>;
  errors: SwiftValidationError[];
}

const UNAVAILABLE_MESSAGES: Record<SwiftUnavailableReason, string> = {
  CORRIDOR_NOT_AVAILABLE:
    'No hay transferencias SWIFT disponibles hacia ese país en esa moneda.',
  CURRENCY_NOT_ALLOWED:
    'Esa moneda no está habilitada todavía para transferencias SWIFT.',
  MODE_NOT_SUPPORTED:
    'Ese destino no admite transferencias SWIFT desde una cuenta de empresa.',
  BENEFICIARY_TYPE_NOT_SUPPORTED:
    'Ese destino no admite este tipo de beneficiario (persona/empresa).',
  PROVIDER_UNAVAILABLE:
    'No pudimos consultar los requisitos del destino. Intenta de nuevo en unos minutos.',
};

/**
 * Corredores SWIFT de Tazapay y el esquema del formulario de beneficiario.
 *
 * Tazapay es la fuente de verdad de QUÉ campos se piden (metadata por país y
 * moneda); Guira agrega reglas que la metadata no trae
 * (tazapay_corridor_rules) y decide CÓMO se muestra cada campo (diccionario).
 * El mismo esquema se usa para pintar el formulario y para validar el alta en
 * el backend, que no confía en lo que haya pintado el front.
 */
@Injectable()
export class TazapayCorridorService {
  private readonly logger = new Logger(TazapayCorridorService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly client: TazapayApiClient,
    private readonly eligibility: TazapaySwiftEligibilityService,
  ) {}

  // ── Metadata con caché ────────────────────────────────────────────────

  /**
   * Corredores SWIFT de un país. La consulta va sin moneda: Tazapay devuelve
   * todos los corredores del país en una sola respuesta, que se cachea 24 h.
   * Si Tazapay no responde se usa la copia vencida; sin copia, null.
   */
  async getCountryCorridors(
    country: string,
  ): Promise<{ methods: TazapayPayoutMethod[]; stale: boolean } | null> {
    const cc = country.toUpperCase();
    const { data: cached } = await this.supabase
      .from('tazapay_corridor_cache')
      .select('response, fetched_at')
      .eq('country', cc)
      .eq('payout_type', PAYOUT_TYPE)
      .maybeSingle();

    const fresh =
      cached?.fetched_at &&
      Date.now() - new Date(cached.fetched_at as string).getTime() <
        CACHE_TTL_MS;
    if (cached && fresh) {
      return { methods: this.extractMethods(cached.response), stale: false };
    }

    try {
      const response = await this.client.get<Record<string, unknown>>(
        `/v3/metadata/payout/bank?country=${encodeURIComponent(cc)}&payout_type=${PAYOUT_TYPE}`,
      );
      await this.supabase.from('tazapay_corridor_cache').upsert(
        {
          country: cc,
          payout_type: PAYOUT_TYPE,
          response,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'country,payout_type' },
      );
      return { methods: this.extractMethods(response), stale: false };
    } catch (err) {
      // Un 4xx (p. ej. país no soportado) es una respuesta válida: no hay
      // corredores. Se cachea vacío para no repetir la consulta.
      if (err instanceof TazapayApiError && err.status && !err.retryable) {
        this.logger.warn(
          `Metadata SWIFT ${cc}: Tazapay respondió ${err.status}; se trata como país sin corredores.`,
        );
        await this.supabase.from('tazapay_corridor_cache').upsert(
          {
            country: cc,
            payout_type: PAYOUT_TYPE,
            response: {
              data: { payout_methods: [] },
              guira_status: err.status,
            },
            fetched_at: new Date().toISOString(),
          },
          { onConflict: 'country,payout_type' },
        );
        return { methods: [], stale: false };
      }
      if (cached) {
        this.logger.warn(
          `Metadata SWIFT ${cc}: Tazapay no respondió (${(err as Error).message}); se usa la copia vencida.`,
        );
        return { methods: this.extractMethods(cached.response), stale: true };
      }
      this.logger.error(
        `Metadata SWIFT ${cc}: Tazapay no respondió y no hay copia en caché: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Borra la caché de un país (las reglas de Tazapay cambiaron). */
  async invalidate(country: string): Promise<void> {
    await this.supabase
      .from('tazapay_corridor_cache')
      .delete()
      .eq('country', country.toUpperCase())
      .eq('payout_type', PAYOUT_TYPE);
  }

  /** Monedas SWIFT disponibles hacia un país (filtradas por configuración). */
  async listCurrencies(country: string): Promise<{
    available: boolean;
    currencies: SwiftCurrencyOption[];
    message: string | null;
  }> {
    const corridors = await this.getCountryCorridors(country);
    if (!corridors) {
      return {
        available: false,
        currencies: [],
        message: UNAVAILABLE_MESSAGES.PROVIDER_UNAVAILABLE,
      };
    }
    const allowed = await this.eligibility.getAllowedCurrencies();
    const seen = new Set<string>();
    const currencies: SwiftCurrencyOption[] = [];
    for (const method of corridors.methods) {
      const currency = String(method.currency ?? '').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency) || seen.has(currency)) continue;
      if (allowed.length > 0 && !allowed.includes(currency)) continue;
      seen.add(currency);
      const caps = this.capabilities(method);
      currencies.push({
        currency,
        delivery_time: caps.delivery_time,
        transfer_limit: caps.transfer_limit,
      });
    }
    currencies.sort((a, b) =>
      a.currency === 'USD'
        ? -1
        : b.currency === 'USD'
          ? 1
          : a.currency.localeCompare(b.currency),
    );
    return {
      available: currencies.length > 0,
      currencies,
      message:
        currencies.length > 0
          ? null
          : UNAVAILABLE_MESSAGES.CORRIDOR_NOT_AVAILABLE,
    };
  }

  // ── Esquema del formulario ────────────────────────────────────────────

  async getFormSchema(
    country: string,
    currency: string,
    beneficiaryType?: BeneficiaryType | null,
  ): Promise<SwiftFormSchema> {
    const cc = country.toUpperCase();
    const cur = currency.toUpperCase();
    const unavailable = (reason: SwiftUnavailableReason): SwiftFormSchema => ({
      available: false,
      country: cc,
      currency: cur,
      reason,
      message: UNAVAILABLE_MESSAGES[reason],
    });

    const allowed = await this.eligibility.getAllowedCurrencies();
    if (allowed.length > 0 && !allowed.includes(cur)) {
      return unavailable('CURRENCY_NOT_ALLOWED');
    }

    const corridors = await this.getCountryCorridors(cc);
    if (!corridors) return unavailable('PROVIDER_UNAVAILABLE');

    const method = corridors.methods.find(
      (m) => String(m.currency ?? '').toUpperCase() === cur,
    );
    if (!method) return unavailable('CORRIDOR_NOT_AVAILABLE');

    const caps = this.capabilities(method);

    // En esta etapa el remitente siempre es empresa (KYB). Si Tazapay publica
    // los modos y no hay ninguno B2x, el corredor no sirve. Si no los publica
    // (hoy no vienen ni en sandbox ni en producción), se tolera.
    const modes = caps.supported_modes;
    let beneficiaryTypes = this.beneficiaryTypes(method);
    if (modes.length > 0) {
      if (!modes.includes('B2B') && !modes.includes('B2C')) {
        return unavailable('MODE_NOT_SUPPORTED');
      }
      beneficiaryTypes = beneficiaryTypes.filter((t) =>
        t === 'business' ? modes.includes('B2B') : modes.includes('B2C'),
      );
    }
    if (beneficiaryTypes.length === 0) return unavailable('MODE_NOT_SUPPORTED');
    if (beneficiaryType && !beneficiaryTypes.includes(beneficiaryType)) {
      return unavailable('BENEFICIARY_TYPE_NOT_SUPPORTED');
    }

    const rules = (await this.loadRules(cc)).filter(
      (r) =>
        (!r.currency || r.currency.toUpperCase() === cur) &&
        (!r.beneficiary_type || r.beneficiary_type === beneficiaryType),
    );

    // ── Qué campos y con qué obligatoriedad ──
    const required = new Set<string>();
    const recommended = new Set<string>();
    const addAll = (target: Set<string>, keys: string[]) =>
      keys.forEach((k) => target.add(k));

    addAll(required, SWIFT_BASE_REQUIRED_KEYS);
    for (const raw of method.required_bank_fields ?? []) {
      addAll(required, metadataKeyToDictionaryKeys('bank', raw));
    }
    for (const raw of method.required_bank_codes ?? []) {
      addAll(required, metadataKeyToDictionaryKeys('bank_codes', raw));
    }
    for (const raw of method.required_beneficiary_fields ?? []) {
      addAll(required, metadataKeyToDictionaryKeys('beneficiary', raw));
    }
    const rec = method.recommended_fields ?? {};
    for (const raw of rec.recommended_bank_fields ?? []) {
      addAll(recommended, metadataKeyToDictionaryKeys('bank', raw));
    }
    for (const raw of rec.recommended_bank_codes ?? []) {
      addAll(recommended, metadataKeyToDictionaryKeys('bank_codes', raw));
    }
    for (const raw of rec.recommended_beneficiary_fields ?? []) {
      addAll(recommended, metadataKeyToDictionaryKeys('beneficiary', raw));
    }

    const patternOverrides = new Map<
      string,
      { pattern: string; message: string | null }
    >();
    const blocked: string[] = [];
    const allowedPrefixes: string[] = [];
    const notices: string[] = [];

    for (const rule of rules) {
      const keys = rule.field_key
        ? ruleKeyToDictionaryKeys(rule.field_key)
        : [];
      switch (rule.rule_type) {
        case 'require_field':
          addAll(required, keys);
          if (rule.message_es) notices.push(rule.message_es);
          break;
        case 'recommend_field':
          addAll(recommended, keys);
          break;
        case 'field_pattern': {
          const pattern = rule.value?.pattern;
          if (typeof pattern === 'string') {
            keys.forEach((k) =>
              patternOverrides.set(k, { pattern, message: rule.message_es }),
            );
          }
          break;
        }
        case 'blocked_swift_codes':
          blocked.push(...this.stringList(rule.value?.codes));
          if (rule.message_es) notices.push(rule.message_es);
          break;
        case 'allowed_swift_prefixes':
          allowedPrefixes.push(...this.stringList(rule.value?.prefixes));
          if (rule.message_es) notices.push(rule.message_es);
          break;
        case 'notice':
        case 'payout_requirement':
          if (rule.message_es) notices.push(rule.message_es);
          break;
      }
    }

    // IBAN y número de cuenta: Tazapay acepta cualquiera de los dos. Si el
    // corredor menciona el IBAN, se ofrecen ambos como "uno de dos".
    const ibanMentioned =
      required.has('bank.iban') || recommended.has('bank.iban');
    if (ibanMentioned) {
      required.delete('bank.iban');
      recommended.delete('bank.iban');
    }

    const keys = new Set<string>([
      ...required,
      ...recommended,
      ...BASE_OPTIONAL_KEYS,
      ...(ibanMentioned ? ['bank.iban'] : []),
    ]);

    const fields: SwiftSchemaField[] = [];
    for (const key of keys) {
      const def = SWIFT_FIELD_DICTIONARY.get(key);
      if (!def) {
        this.logger.warn(
          `Corredor SWIFT ${cc}/${cur}: Tazapay pide el campo "${key}", que no está en el diccionario. Agrégalo a tazapay-field-dictionary.ts.`,
        );
      }
      const override = patternOverrides.get(key);
      const inOneOf =
        ibanMentioned && (key === 'bank.account_number' || key === 'bank.iban');
      const field: SwiftSchemaField = {
        key,
        label: def?.label ?? fallbackLabel(key),
        control: def?.control ?? 'text',
        group: def?.group ?? 'extra',
        required: inOneOf ? false : required.has(key),
        recommended: !required.has(key) && recommended.has(key),
        maxLength: def?.maxLength ?? UNKNOWN_FIELD_MAX_LENGTH,
        known: !!def,
      };
      const pattern = override?.pattern ?? def?.pattern;
      if (pattern) field.pattern = pattern;
      const patternMessage = override?.message ?? def?.patternMessage;
      if (patternMessage) field.patternMessage = patternMessage;
      if (def?.options) field.options = def.options;
      if (def?.placeholder) field.placeholder = def.placeholder;
      if (def?.help) field.help = def.help;
      if (key === 'address.country') field.defaultValue = cc;
      if (inOneOf) field.oneOfGroup = ACCOUNT_ONE_OF_GROUP;
      fields.push(field);
    }

    fields.sort((a, b) => {
      const g =
        SWIFT_FIELD_GROUP_ORDER.indexOf(a.group) -
        SWIFT_FIELD_GROUP_ORDER.indexOf(b.group);
      if (g !== 0) return g;
      return (
        (SWIFT_FIELD_ORDER.get(a.key) ?? Number.MAX_SAFE_INTEGER) -
        (SWIFT_FIELD_ORDER.get(b.key) ?? Number.MAX_SAFE_INTEGER)
      );
    });

    return {
      available: true,
      country: cc,
      currency: cur,
      beneficiary_type: beneficiaryType ?? null,
      beneficiary_types: beneficiaryTypes,
      fields,
      bank_rules: {
        blocked_swift_codes: [...new Set(blocked)],
        allowed_swift_prefixes: [...new Set(allowedPrefixes)],
      },
      notices: [...new Set(notices)],
      corridor: caps,
      stale: corridors.stale,
    };
  }

  // ── Validación del alta ───────────────────────────────────────────────

  /**
   * Valida y normaliza los campos enviados por el cliente contra el esquema
   * del corredor. Rechaza claves que el esquema no ofrece: así el cliente no
   * puede colar campos arbitrarios en el body que se manda a Tazapay.
   */
  validateAgainstSchema(
    schema: Extract<SwiftFormSchema, { available: true }>,
    input: Record<string, unknown>,
  ): SwiftValidationResult {
    const errors: SwiftValidationError[] = [];
    const values: Record<string, string> = {};
    const byKey = new Map(schema.fields.map((f) => [f.key, f]));

    for (const key of Object.keys(input ?? {})) {
      if (!byKey.has(key)) {
        errors.push({
          field: key,
          message: 'Este campo no corresponde a este destino.',
        });
      }
    }

    for (const field of schema.fields) {
      const raw = input?.[field.key];
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        errors.push({
          field: field.key,
          message: `${field.label}: valor inválido.`,
        });
        continue;
      }
      const value = normalizeSwiftValue(
        SWIFT_FIELD_DICTIONARY.get(field.key),
        raw,
      );
      if (!value) continue;
      if (value.length > field.maxLength) {
        errors.push({
          field: field.key,
          message: `${field.label}: máximo ${field.maxLength} caracteres.`,
        });
        continue;
      }
      if (field.pattern && !new RegExp(field.pattern).test(value)) {
        errors.push({
          field: field.key,
          message: field.patternMessage
            ? `${field.label}: ${field.patternMessage}`
            : `${field.label}: formato inválido.`,
        });
        continue;
      }
      values[field.key] = value;
    }

    // Obligatorios (los "uno de dos" se revisan por grupo).
    const oneOfGroups = new Map<string, SwiftSchemaField[]>();
    for (const field of schema.fields) {
      if (field.oneOfGroup) {
        oneOfGroups.set(field.oneOfGroup, [
          ...(oneOfGroups.get(field.oneOfGroup) ?? []),
          field,
        ]);
        continue;
      }
      if (
        field.required &&
        !values[field.key] &&
        !errors.some((e) => e.field === field.key)
      ) {
        errors.push({
          field: field.key,
          message: `${field.label} es obligatorio.`,
        });
      }
    }
    for (const group of oneOfGroups.values()) {
      const filled = group.some((f) => values[f.key]);
      const hasFormatError = group.some((f) =>
        errors.some((e) => e.field === f.key),
      );
      if (!filled && !hasFormatError) {
        errors.push({
          field: group[0].key,
          message: `Indica ${group.map((f) => f.label).join(' o ')}.`,
        });
      }
    }

    // IBAN: dígito de control y país.
    const iban = values['bank.iban'];
    if (iban) {
      if (!isValidIbanChecksum(iban)) {
        errors.push({
          field: 'bank.iban',
          message: 'El IBAN no es válido (dígito de control).',
        });
      } else if (iban.slice(0, 2) !== schema.country) {
        errors.push({
          field: 'bank.iban',
          message: `El IBAN no corresponde al país del banco (${schema.country}).`,
        });
      }
    }

    // SWIFT: país del código y reglas de bancos.
    const swift = values['bank_codes.swift_code'];
    if (swift) {
      if (swift.slice(4, 6) !== schema.country) {
        errors.push({
          field: 'bank_codes.swift_code',
          message: `El código SWIFT es de otro país (${swift.slice(4, 6)}), no de ${schema.country}.`,
        });
      }
      const swift11 = swift.length === 8 ? `${swift}XXX` : swift;
      const blocked = schema.bank_rules.blocked_swift_codes.map((c) =>
        c.toUpperCase(),
      );
      if (blocked.some((c) => c === swift || c === swift11)) {
        errors.push({
          field: 'bank_codes.swift_code',
          message: 'No se pueden enviar pagos a ese banco en esta moneda.',
        });
      }
      const prefixes = schema.bank_rules.allowed_swift_prefixes.map((p) =>
        p.toUpperCase(),
      );
      if (prefixes.length > 0 && !prefixes.some((p) => swift.startsWith(p))) {
        errors.push({
          field: 'bank_codes.swift_code',
          message: 'En esta moneda solo se admiten pagos a bancos específicos.',
        });
      }
    }

    // Fecha de nacimiento real.
    const dob = values['date_of_birth'];
    if (dob && Number.isNaN(new Date(`${dob}T00:00:00Z`).getTime())) {
      errors.push({
        field: 'date_of_birth',
        message: 'Fecha de nacimiento inválida.',
      });
    }

    return { values, errors };
  }

  // ── Auxiliares ────────────────────────────────────────────────────────

  private extractMethods(response: unknown): TazapayPayoutMethod[] {
    const data = (response as { data?: { payout_methods?: unknown } } | null)
      ?.data;
    const methods = Array.isArray(data?.payout_methods)
      ? data.payout_methods
      : [];
    return (methods as TazapayPayoutMethod[]).filter(
      (m) => String(m?.payout_type ?? '').toLowerCase() === PAYOUT_TYPE,
    );
  }

  /**
   * En SWIFT las capacidades vienen en el nivel superior; con la red
   * cross_border_wire (USD) pueden venir en esa red. Se toma el nivel que
   * traiga datos.
   */
  capabilities(method: TazapayPayoutMethod): SwiftCorridorInfo {
    const network = (method.fund_transfer_networks ?? [])[0];
    const pick = <K extends keyof CapabilityFields>(key: K) => {
      const top = method[key];
      const isEmpty =
        top === undefined ||
        top === null ||
        (Array.isArray(top) && top.length === 0);
      return (isEmpty ? network?.[key] : top) ?? null;
    };
    return {
      network: network?.name ?? null,
      transfer_limit: pick('transfer_limit') ?? null,
      delivery_time: pick('delivery_time') ?? null,
      cutoff_schedule: pick('cutoff_schedule') ?? null,
      supported_modes: this.stringList(pick('supported_modes')).map((m) =>
        m.toUpperCase(),
      ),
      restricted_purpose_codes: this.stringList(
        pick('restricted_purpose_codes'),
      ),
    };
  }

  private beneficiaryTypes(method: TazapayPayoutMethod): BeneficiaryType[] {
    const raw = this.stringList(method.beneficiary_type).map((t) =>
      t.toLowerCase(),
    );
    const types = raw.filter(
      (t): t is BeneficiaryType => t === 'individual' || t === 'business',
    );
    return types.length > 0 ? types : ['business', 'individual'];
  }

  private async loadRules(country: string): Promise<CorridorRule[]> {
    const { data, error } = await this.supabase
      .from('tazapay_corridor_rules')
      .select(
        'country, currency, beneficiary_type, rule_type, field_key, value, message_es',
      )
      .eq('country', country)
      .eq('is_active', true);
    if (error) {
      this.logger.warn(
        `No se pudieron leer las reglas SWIFT de ${country}: ${error.message}`,
      );
      return [];
    }
    return (data ?? []) as CorridorRule[];
  }

  private stringList(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
      : [];
  }
}

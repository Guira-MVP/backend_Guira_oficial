/**
 * Elegibilidad de una empresa para Tazapay según su industria y actividades.
 * Política (Docuemntacion_nueva_integracion/AUDITORIA_RESTRICCIONES_NEGOCIO_TAZAPAY.md):
 * solo se envía si el vertical describe honestamente la actividad; si no,
 * la empresa queda solo con Bridge (sin SWIFT). Nunca se usa `other` ni un
 * vertical "parecido". Reglas de uso: TABLA_EQUIVALENCIAS_NAICS_TAZAPAY.md §4.
 */

export type VerticalQuality =
  | 'exacta'
  | 'generica'
  | 'confirmar_tazapay'
  | 'sin_vertical'
  | 'no_elegible';

export interface NaicsRule {
  naics_prefix: string;
  vertical: string | null;
  quality: VerticalQuality;
  requires_compliance: boolean;
  note: string | null;
}

export interface IndustryEvaluation {
  quality: VerticalQuality;
  /** Vertical propuesto (candidato si quality = confirmar_tazapay). */
  vertical: string | null;
  requiresCompliance: boolean;
  reasons: string[];
  /** Código NAICS principal (el primero que eligió el cliente). */
  primaryNaics: string | null;
}

/** Peor primero: la empresa toma la peor calidad entre todas sus industrias. */
const SEVERITY: Record<VerticalQuality, number> = {
  exacta: 0,
  generica: 1,
  confirmar_tazapay: 2,
  sin_vertical: 3,
  no_elegible: 4,
};

const NOT_ELIGIBLE_ACTIVITIES = new Set([
  'gambling',
  'weapons_firearms_and_explosives',
  'marijuana_or_related_services',
  'adult_entertainment',
  'nicotine_tobacco_or_related_services',
]);
const CONFIRM_ACTIVITIES = new Set([
  'operate_foreign_exchange_virtual_currencies_brokerage_otc',
  'pharmaceuticals',
  'precious_metals_precious_stones_jewelry',
]);
export const MSB_VERTICAL = 'Financial Service - Remittance & MSB';
export const PSP_VERTICAL =
  'Financial Service - Digital Wallets, PSPs & Fintech';

export function normalizeIndustryCodes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // un único código como texto
    }
    return [value.trim()];
  }
  return [];
}

export function findRule(code: string, rules: NaicsRule[]): NaicsRule | null {
  let best: NaicsRule | null = null;
  for (const rule of rules) {
    if (
      code.startsWith(rule.naics_prefix) &&
      (!best || rule.naics_prefix.length > best.naics_prefix.length)
    ) {
      best = rule;
    }
  }
  return best;
}

export function evaluateIndustry(params: {
  industryCodes: string[];
  rules: NaicsRule[];
  highRiskActivities?: string[] | null;
  conductsMoneyServices?: boolean | null;
}): IndustryEvaluation {
  const codes = params.industryCodes;
  const reasons: string[] = [];
  if (codes.length === 0) {
    return {
      quality: 'sin_vertical',
      vertical: null,
      requiresCompliance: false,
      reasons: ['La empresa no declaró ninguna industria (NAICS).'],
      primaryNaics: null,
    };
  }

  const primaryRule = findRule(codes[0], params.rules);
  let quality: VerticalQuality = primaryRule?.quality ?? 'sin_vertical';
  let vertical = primaryRule?.vertical ?? null;
  let requiresCompliance = primaryRule?.requires_compliance ?? false;
  if (!primaryRule) reasons.push(`Sin regla para el NAICS ${codes[0]}.`);
  else if (
    primaryRule.note &&
    SEVERITY[primaryRule.quality] >= SEVERITY.confirmar_tazapay
  ) {
    reasons.push(`${codes[0]}: ${primaryRule.note}`);
  }

  // Regla de la peor calidad entre todas las industrias declaradas.
  for (const code of codes.slice(1)) {
    const rule = findRule(code, params.rules);
    const q = rule?.quality ?? 'sin_vertical';
    if (rule?.requires_compliance) requiresCompliance = true;
    if (SEVERITY[q] > SEVERITY[quality]) {
      quality = q;
      reasons.push(`Industria adicional ${code}: ${rule?.note ?? q}`);
      if (q === 'sin_vertical' || q === 'no_elegible') vertical = null;
    }
  }
  if (
    !primaryRule?.note &&
    SEVERITY[quality] >= SEVERITY.sin_vertical &&
    reasons.length === 0
  ) {
    reasons.push('Tazapay no tiene un vertical que describa esta actividad.');
  }

  // Ajuste por riesgo: prevalece sobre el NAICS.
  const activities = (params.highRiskActivities ?? []).filter(
    (a) => a && a !== 'none_of_the_above',
  );
  const notEligible = activities.filter((a) => NOT_ELIGIBLE_ACTIVITIES.has(a));
  if (notEligible.length > 0) {
    return {
      quality: 'no_elegible',
      vertical: null,
      requiresCompliance: true,
      reasons: [
        ...reasons,
        `Actividad de alto riesgo no admitida: ${notEligible.join(', ')}.`,
      ],
      primaryNaics: codes[0],
    };
  }

  if (SEVERITY[quality] <= SEVERITY.generica) {
    if (params.conductsMoneyServices || activities.includes('money_services')) {
      vertical = MSB_VERTICAL;
      quality = 'exacta';
      requiresCompliance = true;
      reasons.push(
        'Presta servicios de dinero: vertical de remesas/MSB con revisión de compliance.',
      );
    } else if (activities.includes('third_party_payment_processing')) {
      vertical = PSP_VERTICAL;
      quality = 'exacta';
      requiresCompliance = true;
      reasons.push(
        'Procesa pagos de terceros: vertical de PSP/fintech con revisión de compliance.',
      );
    }
  }

  const toConfirm = activities.filter((a) => CONFIRM_ACTIVITIES.has(a));
  if (toConfirm.length > 0 && SEVERITY[quality] < SEVERITY.confirmar_tazapay) {
    quality = 'confirmar_tazapay';
    requiresCompliance = true;
    reasons.push(
      `Actividad regulada pendiente de confirmación de Tazapay: ${toConfirm.join(', ')}.`,
    );
  }

  return {
    quality,
    vertical,
    requiresCompliance,
    reasons,
    primaryNaics: codes[0],
  };
}

/**
 * Fixed Outputs para bridge_wallet_to_fiat_us con destino no-USD.
 *
 * El Transfer se crea con `source.amount` (USDC que se debitan) y
 * `destination.amount` (lo que recibe el proveedor, garantizado por Bridge).
 * Bridge exige que source.amount cubra `destino / sell_rate + developer_fee`,
 * redondeado al centavo hacia arriba (verificado con dry_run en sandbox el
 * 2026-09-24: 100 EUR / 0.8955 + 1 = 112.67 pasa, 112.66 falla). Lo que sobra va
 * a la wallet "Fixed Outputs Excess Funds" de Guira.
 *
 * Guira cotiza con la tasa CON spread (USD_X.effective_rate), así que la
 * diferencia contra el mínimo de Bridge es a la vez la ganancia cambiaria y el
 * colchón frente a variaciones de la tasa hasta que se crea el Transfer.
 */

/** Divisas destino que se liquidan con Fixed Outputs. */
export const FIXED_OUTPUT_DEST_CURRENCIES = [
  'EUR',
  'MXN',
  'BRL',
  'GBP',
  'COP',
] as const;

/**
 * Único token de origen admitido para destinos no-USD. En sandbox USDT→EUR
 * devuelve "route not supported" (y "developer_fee cannot be set for usdt ->
 * eur" incluso sin Fixed Outputs).
 */
export const NON_USD_ALLOWED_SOURCE_CURRENCY = 'USDC';

export function isFixedOutputCurrency(currency: string): boolean {
  return (FIXED_OUTPUT_DEST_CURRENCIES as readonly string[]).includes(
    currency.toUpperCase(),
  );
}

export interface FeeRule {
  fee_type: 'percent' | 'fixed' | 'mixed';
  fee_percent: number;
  fee_fixed: number;
  min_fee: number;
  max_fee: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ceil2 = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;
const floor2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100;

/** Réplica exacta de FeesService.calculateFee (centavos enteros + min/max). */
export function computeFee(amount: number, rule: FeeRule | null): number {
  if (!rule) return 0;
  const amountCents = Math.round(amount * 100);
  const fixedCents = Math.round(rule.fee_fixed * 100);
  let feeCents = 0;
  if (rule.fee_type === 'percent') {
    feeCents = Math.round((amountCents * rule.fee_percent) / 100);
  } else if (rule.fee_type === 'fixed') {
    feeCents = fixedCents;
  } else if (rule.fee_type === 'mixed') {
    feeCents = fixedCents + Math.round((amountCents * rule.fee_percent) / 100);
  }
  const minCents = Math.round(rule.min_fee * 100);
  const maxCents = Math.round(rule.max_fee * 100);
  if (minCents > 0) feeCents = Math.max(feeCents, minCents);
  if (maxCents > 0) feeCents = Math.min(feeCents, maxCents);
  return feeCents / 100;
}

/** Mínimo de USDC que Bridge acepta como source.amount. */
export function bridgeMinSourceAmount(
  destinationAmount: number,
  bridgeSellRate: number,
  developerFee: number,
): number {
  return ceil2(destinationAmount / bridgeSellRate + developerFee);
}

/** Destino garantizable si el cliente fija los USDC a enviar (camino inverso). */
export function destinationFromSource(
  sourceAmount: number,
  clientRate: number,
  rule: FeeRule | null,
): number {
  const net = sourceAmount - computeFee(sourceAmount, rule);
  return net > 0 ? floor2(net * clientRate) : 0;
}

export interface FixedOutputAmounts {
  source_amount: number;
  fee_amount: number;
  net_amount: number;
  destination_amount: number;
  client_rate: number;
  bridge_min_source_amount: number;
  fx_buffer_amount: number;
}

/**
 * Gross-up: USDC mínimos a debitar para que, con la tasa del cliente y
 * descontada la comisión, lleguen `destinationAmount` al proveedor.
 */
export function calculateFixedOutputAmounts(args: {
  destinationAmount: number;
  clientRate: number;
  bridgeSellRate: number;
  rule: FeeRule | null;
}): FixedOutputAmounts {
  const { destinationAmount, clientRate, bridgeSellRate, rule } = args;
  if (!(destinationAmount > 0) || !(clientRate > 0) || !(bridgeSellRate > 0)) {
    throw new Error('Montos o tasas inválidos para Fixed Outputs');
  }

  const netRequired = ceil2(destinationAmount / clientRate);
  const pct = rule && rule.fee_type !== 'fixed' ? rule.fee_percent / 100 : 0;
  const fixed = rule && rule.fee_type !== 'percent' ? rule.fee_fixed : 0;
  let source = ceil2(
    pct < 1 ? (netRequired + fixed) / (1 - pct) : netRequired + fixed,
  );

  // El redondeo por centavos y los min/max de la regla hacen que la fórmula
  // cerrada pueda quedarse corta o pasarse: se ajusta centavo a centavo.
  const covers = (s: number) => round2(s - computeFee(s, rule)) >= netRequired;
  for (let i = 0; i < 100_000 && !covers(source); i++)
    source = round2(source + 0.01);
  for (
    let i = 0;
    i < 100_000 && source > 0.01 && covers(round2(source - 0.01));
    i++
  ) {
    source = round2(source - 0.01);
  }

  const fee = computeFee(source, rule);
  const bridgeMin = bridgeMinSourceAmount(
    destinationAmount,
    bridgeSellRate,
    fee,
  );
  return {
    source_amount: source,
    fee_amount: fee,
    net_amount: round2(source - fee),
    destination_amount: destinationAmount,
    client_rate: clientRate,
    bridge_min_source_amount: bridgeMin,
    fx_buffer_amount: round2(source - bridgeMin),
  };
}

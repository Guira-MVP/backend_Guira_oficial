// ═══════════════════════════════════════════════════════════════════
//  CATÁLOGO DE RAILS FIAT — proveedores/cuentas bancarias internacionales
//
//  Fuente de verdad para el mapeo riel de pago → divisa fiat que liquida.
//  Usado por suppliers.service.ts (crear proveedor/liquidation address) y
//  por fees (calculateFee/getFeePercent, DTOs de override) para el flujo
//  bridge_wallet_to_fiat_us, donde la comisión se calcula por RIEL/DIVISA
//  DE DESTINO en vez de por divisa de origen.
// ═══════════════════════════════════════════════════════════════════

/** Riel de pago → divisa fiat en la que liquida ese riel. */
export const FIAT_RAIL_TO_CURRENCY: Record<string, string> = {
  ach: 'usd',
  wire: 'usd',
  ach_wire: 'usd', // valor especial de solo-entrada al crear proveedor (genera 2 filas: ach + wire)
  sepa: 'eur',
  spei: 'mxn',
  pix: 'brl',
  bre_b: 'cop',
  co_bank_transfer: 'cop',
  faster_payments: 'gbp',
};

/**
 * Rails de destino reales soportados por bridge_wallet_to_fiat_us (sin el
 * valor sintético 'ach_wire', que nunca se persiste como payment_rail).
 */
export const RAMP_OFF_FIAT_US_DESTINATION_RAILS = [
  'ach',
  'wire',
  'sepa',
  'spei',
  'pix',
  'bre_b',
  'co_bank_transfer',
  'faster_payments',
] as const;

/** Valores válidos de payment_rail para fees_config/customer_fee_overrides. */
export const FEE_PAYMENT_RAILS = [
  'psav',
  'bridge',
  ...RAMP_OFF_FIAT_US_DESTINATION_RAILS,
] as const;

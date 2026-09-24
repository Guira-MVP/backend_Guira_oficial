import {
  bridgeMinSourceAmount,
  calculateFixedOutputAmounts,
  computeFee,
  destinationFromSource,
  FeeRule,
  isFixedOutputCurrency,
} from './fiat-us-fixed-output';

const pct3: FeeRule = {
  fee_type: 'percent',
  fee_percent: 3,
  fee_fixed: 0,
  min_fee: 0,
  max_fee: 500,
};

describe('fiat-us-fixed-output', () => {
  it('reproduce el mínimo que Bridge exigió en sandbox', () => {
    expect(bridgeMinSourceAmount(100, 0.8955, 1)).toBe(112.67);
    expect(bridgeMinSourceAmount(100, 0.8955, 0)).toBe(111.67);
    expect(bridgeMinSourceAmount(1000, 0.8955, 10)).toBe(1126.7);
  });

  it('sin spread el colchón es cero y el source coincide con el mínimo de Bridge', () => {
    const r = calculateFixedOutputAmounts({
      destinationAmount: 1000,
      clientRate: 0.8955,
      bridgeSellRate: 0.8955,
      rule: pct3,
    });
    expect(r.fx_buffer_amount).toBe(0);
    expect(r.source_amount).toBe(r.bridge_min_source_amount);
  });

  it('con spread del 1% el colchón ronda el 1% del neto', () => {
    const sell = 0.8955;
    const r = calculateFixedOutputAmounts({
      destinationAmount: 1000,
      clientRate: sell * 0.99,
      bridgeSellRate: sell,
      rule: pct3,
    });
    expect(r.net_amount).toBeGreaterThanOrEqual(
      Math.ceil((1000 / (sell * 0.99)) * 100) / 100,
    );
    expect(r.fee_amount).toBe(computeFee(r.source_amount, pct3));
    expect(r.fx_buffer_amount).toBeGreaterThan(11);
    expect(r.fx_buffer_amount).toBeLessThan(11.5);
  });

  it('devuelve el source mínimo: un centavo menos ya no cubre el destino', () => {
    const r = calculateFixedOutputAmounts({
      destinationAmount: 850,
      clientRate: 0.87,
      bridgeSellRate: 0.8746,
      rule: pct3,
    });
    const lower = Math.round((r.source_amount - 0.01) * 100) / 100;
    expect(lower - computeFee(lower, pct3)).toBeLessThan(
      Math.ceil((850 / 0.87) * 100) / 100,
    );
  });

  it('respeta el tope de comisión (max_fee)', () => {
    const r = calculateFixedOutputAmounts({
      destinationAmount: 50_000,
      clientRate: 0.9,
      bridgeSellRate: 0.9,
      rule: pct3,
    });
    expect(r.fee_amount).toBe(500);
  });

  it('sin regla de comisión no cobra fee', () => {
    const r = calculateFixedOutputAmounts({
      destinationAmount: 100,
      clientRate: 0.9,
      bridgeSellRate: 0.9,
      rule: null,
    });
    expect(r.fee_amount).toBe(0);
    expect(r.source_amount).toBe(111.12);
  });

  it('el camino inverso (monto a enviar) nunca promete más de lo que cubre el gross-up', () => {
    const dest = destinationFromSource(1000, 0.8955, pct3);
    const r = calculateFixedOutputAmounts({
      destinationAmount: dest,
      clientRate: 0.8955,
      bridgeSellRate: 0.8955,
      rule: pct3,
    });
    expect(r.source_amount).toBeLessThanOrEqual(1000);
  });

  it('solo divisas soportadas por Fixed Outputs', () => {
    expect(isFixedOutputCurrency('eur')).toBe(true);
    expect(isFixedOutputCurrency('COP')).toBe(true);
    expect(isFixedOutputCurrency('USD')).toBe(false);
  });
});

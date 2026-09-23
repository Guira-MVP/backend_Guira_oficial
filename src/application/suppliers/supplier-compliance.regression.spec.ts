import { BadRequestException } from '@nestjs/common';
import { SuppliersService } from './suppliers.service';

/**
 * Staging añadió `assertUsableForPayment` en los 7 puntos donde se crea un
 * expediente contra un beneficiario. En main no existía, así que la regla
 * debe dejar pasar a TODOS los beneficiarios que hoy operan en producción:
 * esos no tienen `compliance_status` (la columna ni siquiera existe allí,
 * y al crearla queda en NULL). Solo un bloqueo explícito corta el pago.
 */
describe('SuppliersService.assertUsableForPayment — beneficiarios de main siguen operando', () => {
  const service = new SuppliersService({} as any, {} as any, {} as any, {} as any);

  it.each([
    ['sin la propiedad (fila leída antes de la migración)', {}],
    ['compliance_status = null (valor por defecto de la columna nueva)', { compliance_status: null }],
    ['compliance_status = undefined', { compliance_status: undefined }],
    ['en revisión: se marca pero no se corta el pago', { compliance_status: 'pending_review' }],
  ])('deja pagar: %s', (_label, supplier) => {
    expect(() => service.assertUsableForPayment(supplier)).not.toThrow();
  });

  it('solo un beneficiario bloqueado corta el pago', () => {
    expect(() => service.assertUsableForPayment({ compliance_status: 'blocked' })).toThrow(
      BadRequestException,
    );
  });
});

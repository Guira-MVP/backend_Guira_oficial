import { PaymentOrdersService } from './payment-orders.service';
import { PdfService } from '../../core/pdf/pdf.service';

/**
 * C.T.A.V. (comprobante PSAV) de bolivia_to_world.
 *   1. Muestra los datos bancarios del beneficiario y el código de traza del
 *      pago, no la dirección Solana de fondeo del Transfer.
 *   2. Si se generó antes de completarse la orden, se regenera al completarse
 *      (mismo ctav_id); si es otro documento en receipt_url, no se pisa.
 */
describe('C.T.A.V. de bolivia_to_world', () => {
  describe('PdfService.buildBoliviaToWorldReceiptBank', () => {
    const base = {
      flow_type: 'bolivia_to_world',
      destination_bank_name: 'BBVA México',
      destination_account_number: '012180001234567897',
      destination_account_holder: 'Proveedor MX SA',
      bridge_source_deposit_instructions: {
        type: 'bridge_transfer',
        to_address: 'SoLaNaFondeoGuira1111111111111111111111111',
        destination_payment_rail: 'spei',
      },
    };

    it('usa banco, cuenta y titular del beneficiario, nunca la dirección de fondeo', () => {
      const bank = PdfService.buildBoliviaToWorldReceiptBank(base);
      expect(bank).toMatchObject({
        bankName: 'BBVA México',
        accountNumber: '012180001234567897',
        accountHolder: 'Proveedor MX SA',
        rail: 'SPEI',
      });
      expect(JSON.stringify(bank)).not.toContain('SoLaNaFondeoGuira');
    });

    it('toma el IMAD en Wire y la traza en ACH', () => {
      expect(
        PdfService.buildBoliviaToWorldReceiptBank({
          ...base,
          imad: '20260924XL0D8740333972',
        }),
      ).toMatchObject({
        traceLabel: 'IMAD (Fedwire)',
        traceValue: '20260924XL0D8740333972',
      });
      expect(
        PdfService.buildBoliviaToWorldReceiptBank({
          ...base,
          ach_trace_number: '0210000217182685',
        }),
      ).toMatchObject({
        traceLabel: 'N° de Traza ACH',
        traceValue: '0210000217182685',
      });
    });

    it('sin pago completado el código de traza queda vacío', () => {
      expect(
        PdfService.buildBoliviaToWorldReceiptBank(base).traceValue,
      ).toBeNull();
    });
  });

  describe('storePsavReceiptOnCompletion', () => {
    const COMPLETED_AT = '2026-09-24T20:00:00.000Z';
    const completedMs = Date.parse(COMPLETED_AT);

    function makeService(order: Record<string, unknown>) {
      const q: any = {};
      q.select = jest.fn(() => q);
      q.eq = jest.fn(() => q);
      q.single = jest.fn(async () => ({ data: order, error: null }));
      const service = Object.create(PaymentOrdersService.prototype) as any;
      service.supabase = { from: jest.fn(() => q) };
      service.logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
      service._storePsavReceipt = jest
        .fn()
        .mockResolvedValue('payment-receipts/x.pdf');
      return service;
    }

    const order = (extra: Record<string, unknown>) => ({
      id: 'order-1',
      user_id: 'user-1',
      flow_type: 'bolivia_to_world',
      status: 'completed',
      completed_at: COMPLETED_AT,
      ...extra,
    });

    it('genera el C.T.A.V. si todavía no existe', async () => {
      const service = makeService(order({ ctav_id: null, receipt_url: null }));
      await service.storePsavReceiptOnCompletion('order-1');
      expect(service._storePsavReceipt).toHaveBeenCalledTimes(1);
    });

    it('regenera un C.T.A.V. generado ANTES de completarse (conserva ctav_id)', async () => {
      const early = order({
        ctav_id: 'ctav-1',
        receipt_url: `payment-receipts/user-1/order-1_ctav_${completedMs - 3_600_000}.pdf`,
      });
      const service = makeService(early);
      await service.storePsavReceiptOnCompletion('order-1');
      expect(service._storePsavReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ ctav_id: 'ctav-1' }),
      );
    });

    it('no regenera un C.T.A.V. generado después de completarse', async () => {
      const service = makeService(
        order({
          ctav_id: 'ctav-1',
          receipt_url: `payment-receipts/user-1/order-1_ctav_${completedMs + 5_000}.pdf`,
        }),
      );
      await service.storePsavReceiptOnCompletion('order-1');
      expect(service._storePsavReceipt).not.toHaveBeenCalled();
    });

    it('no pisa un documento que no es un C.T.A.V. (evidencia del staff)', async () => {
      const service = makeService(
        order({
          ctav_id: 'ctav-1',
          receipt_url: 'payment-receipts/user-1/recibo-psav.pdf',
        }),
      );
      await service.storePsavReceiptOnCompletion('order-1');
      expect(service._storePsavReceipt).not.toHaveBeenCalled();
    });
  });
});

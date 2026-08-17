import { WebhooksService } from './webhooks.service';

/**
 * Tests de la extracción de códigos de trazabilidad bancaria de los depósitos
 * fiat entrantes (webhooks virtual_account.activity.*).
 *
 * Los fixtures son sintéticos pero replican la ESTRUCTURA exacta de
 * `event_object.source` de Bridge, que es lo que la extracción tiene que
 * respetar: cada riel expone el código en una clave distinta y ninguna clave se
 * comparte entre wire y ACH. No se usan datos reales de clientes.
 *
 * Los helpers no usan estado de la instancia, por lo que basta el prototipo:
 * evita construir el servicio con sus nueve dependencias.
 */
describe('WebhooksService — códigos de trazabilidad VA', () => {
  const svc = Object.create(WebhooksService.prototype) as any;

  // Wire: el código viaja en `imad`, el concepto en `wire_message`
  // y el banco emisor en `bank_routing_number`.
  const WIRE_SOURCE = {
    imad: '20260101AAAAAAAA000001',
    bank_name: 'EXAMPLE BANK',
    payment_rail: 'wire',
    wire_message: 'for invoice 0000/00000 servicios de ejemplo',
    originator_name: 'Empresa Ejemplo LLC',
    originator_address: '1 EXAMPLE STREET, SUITE 100, ANYTOWN XX 00000',
    bank_routing_number: '000000000',
    bank_beneficiary_name: 'Beneficiario Ejemplo',
    bank_beneficiary_address: 'CALLE EJEMPLO, CIUDAD EJEMPLO 00000',
  };

  // ACH: el código viaja en `trace_number`, el concepto en `description`
  // y el banco emisor en `sender_bank_routing_number`.
  const ACH_SOURCE = {
    description: 'ExampleACH Empresa Ejem REF-000000000 000000 [Beneficiario]',
    sender_name: 'Empresa Ejem',
    payment_rail: 'ach_push',
    trace_number: '000000000000000',
    sender_bank_routing_number: '000000000',
  };

  // Crypto: ningún código bancario en el payload.
  const CRYPTO_SOURCE = {
    currency: 'usdc',
    from_address: '0x0000000000000000000000000000000000000000',
    payment_rail: 'ethereum',
    payment_received_rail: 'ethereum',
  };

  const NO_CODES = {
    imad: null,
    achTraceNumber: null,
    paymentConcept: null,
    senderBankRoutingNumber: null,
  };

  describe('extractVaTraceCodes', () => {
    it('toma el IMAD y el mensaje del wire, y deja el trace ACH en null', () => {
      expect(svc.extractVaTraceCodes(WIRE_SOURCE)).toEqual({
        imad: '20260101AAAAAAAA000001',
        achTraceNumber: null,
        paymentConcept: 'for invoice 0000/00000 servicios de ejemplo',
        senderBankRoutingNumber: '000000000',
      });
    });

    it('toma el trace number y la descripción del ACH, y deja el IMAD en null', () => {
      expect(svc.extractVaTraceCodes(ACH_SOURCE)).toEqual({
        imad: null,
        achTraceNumber: '000000000000000',
        paymentConcept: ACH_SOURCE.description,
        senderBankRoutingNumber: '000000000',
      });
    });

    it('devuelve todo null en rieles crypto', () => {
      expect(svc.extractVaTraceCodes(CRYPTO_SOURCE)).toEqual(NO_CODES);
    });

    it('no revienta si el evento llega sin source', () => {
      expect(svc.extractVaTraceCodes(undefined)).toEqual(NO_CODES);
    });
  });

  describe('traceCodesToPatch', () => {
    it('omite los nulos para no pisar un código ya capturado', () => {
      // Bridge reenvía la misma actividad como created/updated y no todos los
      // eventos traen `source`: el patch de un evento sin códigos debe ir vacío,
      // o el UPDATE borraría el IMAD que capturó el evento anterior.
      expect(
        svc.traceCodesToPatch(svc.extractVaTraceCodes(CRYPTO_SOURCE)),
      ).toEqual({});
    });

    it('mapea a nombres de columna de payment_orders', () => {
      expect(
        svc.traceCodesToPatch(svc.extractVaTraceCodes(ACH_SOURCE)),
      ).toEqual({
        ach_trace_number: '000000000000000',
        payment_concept: ACH_SOURCE.description,
        sender_bank_routing_number: '000000000',
      });
    });
  });

  describe('vaTraceColumns', () => {
    it('conserva los nulos: es una fila nueva de auditoría, no hay nada que pisar', () => {
      expect(svc.vaTraceColumns(WIRE_SOURCE)).toEqual({
        imad: '20260101AAAAAAAA000001',
        ach_trace_number: null,
        payment_concept: WIRE_SOURCE.wire_message,
        sender_bank_routing_number: '000000000',
      });
    });
  });
});

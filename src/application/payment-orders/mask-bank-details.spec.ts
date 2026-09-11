import {
  maskAccountNumber,
  maskOrderBankDetails,
  maskOrdersIfNeeded,
} from './mask-bank-details';

describe('enmascarado de datos bancarios en expedientes', () => {
  describe('maskAccountNumber', () => {
    it('deja visibles los últimos 4 dígitos', () => {
      expect(maskAccountNumber('1234567890123312')).toBe('••••3312');
    });

    it('oculta por completo los valores demasiado cortos', () => {
      // Con 4 o menos, mostrar "los últimos 4" sería mostrarlo entero.
      expect(maskAccountNumber('1234')).toBe('••••');
      expect(maskAccountNumber('12')).toBe('••••');
    });

    it('no rompe con valores que no son texto', () => {
      expect(maskAccountNumber(null)).toBeNull();
      expect(maskAccountNumber(undefined)).toBeUndefined();
      expect(maskAccountNumber(42)).toBe(42);
    });
  });

  describe('maskOrderBankDetails', () => {
    const order = {
      id: 'order-1',
      amount: 1000,
      destination_account_number: '9876543210001111',
      destination_bank_name: 'Banco Nacional',
      psav_deposit_instructions: {
        bank_name: 'Banco PSAV',
        account_number: '1111222233334444',
        account_holder: 'Guira SRL',
      },
      bridge_source_deposit_instructions: {
        bank_account_number: '5555666677778888',
        bank_routing_number: '021000021',
        deposit_message: 'ref-123',
      },
    };

    it('enmascara el número de cuenta de destino', () => {
      const masked = maskOrderBankDetails(order);
      expect(masked.destination_account_number).toBe('••••1111');
    });

    it('enmascara los números dentro de las instrucciones de depósito', () => {
      const masked = maskOrderBankDetails(order);
      expect(masked.psav_deposit_instructions.account_number).toBe('••••4444');
      expect(masked.bridge_source_deposit_instructions.bank_account_number).toBe(
        '••••8888',
      );
      expect(masked.bridge_source_deposit_instructions.bank_routing_number).toBe(
        '••••0021',
      );
    });

    it('conserva el resto de la información del expediente', () => {
      const masked = maskOrderBankDetails(order);
      expect(masked.amount).toBe(1000);
      expect(masked.destination_bank_name).toBe('Banco Nacional');
      expect(masked.psav_deposit_instructions.account_holder).toBe('Guira SRL');
      expect(masked.bridge_source_deposit_instructions.deposit_message).toBe(
        'ref-123',
      );
    });

    it('no muta el expediente original', () => {
      const copy = JSON.parse(JSON.stringify(order));
      maskOrderBankDetails(copy);
      expect(copy.destination_account_number).toBe('9876543210001111');
      expect(copy.psav_deposit_instructions.account_number).toBe(
        '1111222233334444',
      );
    });
  });

  describe('maskOrdersIfNeeded', () => {
    const orders = [{ destination_account_number: '9876543210001111' }];

    it('NO enmascara al titular de la cuenta', () => {
      // Es el 100% del tráfico actual: nadie debe ver cambiar sus datos.
      const result = maskOrdersIfNeeded(orders, null);
      expect(result[0].destination_account_number).toBe('9876543210001111');
    });

    it('enmascara en acceso vinculado sin el permiso', () => {
      const result = maskOrdersIfNeeded(orders, {
        capabilities: ['orders:read', 'activity:read'],
      });
      expect(result[0].destination_account_number).toBe('••••1111');
    });

    it('no enmascara si el titular concedió bank_details:full', () => {
      const result = maskOrdersIfNeeded(orders, {
        capabilities: ['orders:read', 'bank_details:full'],
      });
      expect(result[0].destination_account_number).toBe('9876543210001111');
    });

    it('enmascara cuando el contexto vinculado no trae permisos', () => {
      // Defensa ante un vínculo con capabilities vacío: el caso por
      // defecto tiene que ser el seguro, no el abierto.
      const result = maskOrdersIfNeeded(orders, { capabilities: [] });
      expect(result[0].destination_account_number).toBe('••••1111');
    });
  });
});

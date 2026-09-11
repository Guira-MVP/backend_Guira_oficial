import {
  maskAccountNumber,
  maskClientBankAccount,
  maskOrderBankDetails,
  maskOrdersIfNeeded,
  maskSupplierBankDetails,
  maskSuppliersIfNeeded,
  maskWalletAddress,
  maskWalletsIfNeeded,
  shouldMask,
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

  describe('shouldMask', () => {
    it('no enmascara al titular', () => {
      expect(shouldMask(null)).toBe(false);
      expect(shouldMask(undefined)).toBe(false);
    });

    it('enmascara en acceso vinculado sin bank_details:full', () => {
      expect(shouldMask({ capabilities: ['orders:read'] })).toBe(true);
    });

    it('no enmascara si se concedió bank_details:full', () => {
      expect(shouldMask({ capabilities: ['bank_details:full'] })).toBe(false);
    });
  });

  describe('proveedores', () => {
    const supplier = {
      id: 'sup-1',
      name: 'Proveedor SA',
      contact_email: 'pagos@proveedor.com',
      bank_details: {
        bank_name: 'Banco Internacional',
        account_holder_name: 'Proveedor SA',
        account_number: '4444333322221111',
        routing_number: '026009593',
        swift_code: 'BOFAUS3N',
        crypto_address: '0x1234567890abcdef1234567890abcdef12345678',
      },
    };

    it('oculta los identificadores con los que se puede operar', () => {
      const masked = maskSupplierBankDetails(supplier);
      expect(masked.bank_details.account_number).toBe('••••1111');
      expect(masked.bank_details.routing_number).toBe('••••9593');
      expect(masked.bank_details.crypto_address).toBe('••••5678');
    });

    it('conserva lo que hace falta para conciliar', () => {
      // Sin el nombre del beneficiario y del banco, quien concilia no
      // puede hacer su trabajo. Y el SWIFT es un identificador público.
      const masked = maskSupplierBankDetails(supplier);
      expect(masked.bank_details.account_holder_name).toBe('Proveedor SA');
      expect(masked.bank_details.bank_name).toBe('Banco Internacional');
      expect(masked.bank_details.swift_code).toBe('BOFAUS3N');
      expect(masked.name).toBe('Proveedor SA');
    });

    it('no muta el proveedor original', () => {
      const copy = JSON.parse(JSON.stringify(supplier));
      maskSupplierBankDetails(copy);
      expect(copy.bank_details.account_number).toBe('4444333322221111');
    });

    it('tolera proveedores sin datos bancarios', () => {
      expect(() =>
        maskSupplierBankDetails({ id: 'x', bank_details: null }),
      ).not.toThrow();
      expect(() => maskSupplierBankDetails({ id: 'x' })).not.toThrow();
    });

    it('no enmascara al titular', () => {
      const result = maskSuppliersIfNeeded([supplier], null);
      expect(result[0].bank_details.account_number).toBe('4444333322221111');
    });

    it('enmascara en acceso vinculado sin el permiso', () => {
      const result = maskSuppliersIfNeeded([supplier], {
        capabilities: ['suppliers:read'],
      });
      expect(result[0].bank_details.account_number).toBe('••••1111');
    });
  });

  describe('cuenta bancaria propia del cliente', () => {
    const account = {
      id: 'cba-1',
      bank_name: 'Banco Unión',
      account_holder: 'Mi Empresa SRL',
      account_number: '7777888899990000',
      currency: 'BOB',
    };

    it('oculta el número y conserva banco y titular', () => {
      const masked = maskClientBankAccount(account);
      expect(masked.account_number).toBe('••••0000');
      expect(masked.bank_name).toBe('Banco Unión');
      expect(masked.account_holder).toBe('Mi Empresa SRL');
    });

    it('tolera cuentas sin número', () => {
      expect(() => maskClientBankAccount({ id: 'x' })).not.toThrow();
    });
  });

  describe('wallets', () => {
    const wallet = {
      id: 'w-1',
      address: '0xabcdef1234567890abcdef1234567890abcd9999',
      network: 'polygon',
      label: 'Principal',
    };

    it('trata la dirección como un número de cuenta', () => {
      const masked = maskWalletAddress(wallet);
      expect(masked.address).toBe('••••9999');
      expect(masked.network).toBe('polygon');
      expect(masked.label).toBe('Principal');
    });

    it('tolera wallets sin dirección', () => {
      expect(() => maskWalletAddress({ id: 'w-2' })).not.toThrow();
    });

    it('no enmascara al titular', () => {
      const result = maskWalletsIfNeeded([wallet], null);
      expect(result[0].address).toBe(wallet.address);
    });

    it('enmascara en acceso vinculado sin el permiso', () => {
      const result = maskWalletsIfNeeded([wallet], {
        capabilities: ['balances:read'],
      });
      expect(result[0].address).toBe('••••9999');
    });
  });
});

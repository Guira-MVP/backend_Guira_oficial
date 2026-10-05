import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSupplierDto, UpdateSupplierDto } from './create-supplier.dto';
import { SWIFT_FIELD_DICTIONARY } from '../../tazapay/swift/tazapay-field-dictionary';

/**
 * El DTO es la primera barrera: si rechaza una clave válida del formulario
 * SWIFT, el alta falla aunque el servicio la acepte. Pasó con address.line1
 * (la regla de claves no admitía dígitos).
 */
async function errorsFor(cls: any, body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(cls, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

const base = {
  name: 'Shenzhen Hongda Trading Co., Ltd.',
  currency: 'USD',
  payment_rail: 'swift',
  contact_email: 'finance@hongda.cn',
  bank_country: 'CN',
  beneficiary_type: 'business',
};

describe('CreateSupplierDto con payment_rail = swift', () => {
  it('acepta todas las claves del diccionario de campos', async () => {
    const swift_fields = Object.fromEntries(
      [...SWIFT_FIELD_DICTIONARY.keys()].map((k) => [k, 'x']),
    );
    expect(await errorsFor(CreateSupplierDto, { ...base, swift_fields })).toEqual([]);
  });

  it('acepta el alta de ejemplo de China', async () => {
    expect(
      await errorsFor(CreateSupplierDto, {
        ...base,
        swift_fields: {
          'bank.account_holder_name': 'Shenzhen Hongda Trading Co., Ltd.',
          'bank.account_number': '755012345678901',
          'bank.bank_name': 'China Merchants Bank',
          'bank_codes.swift_code': 'CMBCCNBS',
          'address.line1': 'No. 88 Shennan Road',
          'address.line2': 'Piso 3',
          'phone.calling_code': '86',
          'phone.number': '13800138000',
        },
      }),
    ).toEqual([]);
  });

  it('rechaza claves con formato inválido o valores que no son texto', async () => {
    expect(
      await errorsFor(CreateSupplierDto, { ...base, swift_fields: { 'Bank.X-Y': 'a' } }),
    ).toEqual(['swift_fields']);
    expect(
      await errorsFor(CreateSupplierDto, { ...base, swift_fields: { 'bank.account_number': 123 } }),
    ).toEqual(['swift_fields']);
  });

  it('exige país del banco y tipo de titular', async () => {
    const { bank_country: _c, beneficiary_type: _t, ...rest } = base;
    expect((await errorsFor(CreateSupplierDto, rest)).sort()).toEqual([
      'bank_country',
      'beneficiary_type',
    ]);
  });

  it('la edición acepta campos de dirección con dígitos', async () => {
    expect(
      await errorsFor(UpdateSupplierDto, { swift_fields: { 'address.line1': 'Calle 1' } }),
    ).toEqual([]);
  });
});

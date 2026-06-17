import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsIn,
  MaxLength,
  MinLength,
  IsEnum,
  ValidateNested,
  Matches,
  ValidateIf,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BeneficiaryAddressDto } from '../../bridge/dto/create-virtual-account.dto';
import {
  ALLOWED_NETWORKS,
  ALLOWED_CRYPTO_CURRENCIES,
} from '../../../common/constants/guira-crypto-config.constants';

const COLOMBIAN_BANK_CODES = [
  '1001','1002','1006','1007','1009','1012','1013','1019','1023','1032',
  '1040','1047','1051','1052','1053','1059','1060','1061','1062','1063',
  '1065','1066','1067','1069','1070','1071','1097','1121','1283','1286',
  '1289','1292','1303','1370','1507','1551','1558','1637','1801','1802',
  '1803','1804','1805','1808','1809','1811','1812','1814','1815','1816',
] as const;

// EVP (UUID), CPF (11 dígitos), CNPJ (14 dígitos), teléfono BR (+55 + 11 dígitos) o email
const PIX_KEY_REGEX =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{11}|\d{14}|\+55\d{11}|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

const PIX_KEY_FORMAT_MESSAGE =
  'pix_key debe ser un email, CPF (11 dígitos), CNPJ (14 dígitos), teléfono brasileño (+55 + 11 dígitos) o UUID (EVP) válido';

@ValidatorConstraint({ name: 'pixKeyOrBrCode', async: false })
class PixKeyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    const obj = args.object as CreateSupplierDto;
    if (obj.payment_rail !== 'pix') return true;

    const pixKey = typeof value === 'string' ? value.trim() : '';
    if (pixKey) return PIX_KEY_REGEX.test(pixKey);

    const brCode = typeof obj.br_code === 'string' ? obj.br_code.trim() : '';
    return !!brCode;
  }

  defaultMessage(args: ValidationArguments) {
    const obj = args.object as CreateSupplierDto;
    const pixKey = typeof obj.pix_key === 'string' ? obj.pix_key.trim() : '';
    const brCode = typeof obj.br_code === 'string' ? obj.br_code.trim() : '';
    if (!pixKey && !brCode) {
      return 'Para PIX debes proporcionar pix_key o br_code';
    }
    return PIX_KEY_FORMAT_MESSAGE;
  }
}

@ValidatorConstraint({ name: 'supplierDocumentNumber', async: false })
class DocumentNumberConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    const obj = args.object as CreateSupplierDto;
    if (obj.payment_rail === 'co_bank_transfer') {
      return typeof value === 'string' && value.trim().length > 0;
    }
    if (obj.payment_rail === 'pix') {
      if (value === undefined || value === null || value === '') return true;
      return typeof value === 'string' && /^(\d{11}|\d{14})$/.test(value);
    }
    return true;
  }

  defaultMessage(args: ValidationArguments) {
    const obj = args.object as CreateSupplierDto;
    if (obj.payment_rail === 'co_bank_transfer') {
      return 'document_number es requerido para CO Bank Transfer';
    }
    return 'document_number debe ser un CPF (11 dígitos) o CNPJ (14 dígitos), solo números sin puntuación';
  }
}

export class CreateSupplierDto {
  @ApiProperty({ example: 'Acme Logistics S.A.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 'mxn' })
  @IsString()
  @IsNotEmpty()
  currency: string;

  @ApiProperty({
    example: 'spei',
    enum: [
      'ach',
      'wire',
      'sepa',
      'spei',
      'pix',
      'bre_b',
      'faster_payments',
      'co_bank_transfer',
      'crypto',
    ],
  })
  @IsIn([
    'ach',
    'wire',
    'sepa',
    'spei',
    'pix',
    'bre_b',
    'faster_payments',
    'co_bank_transfer',
    'crypto',
  ])
  payment_rail: string;

  @ApiPropertyOptional({ example: 'Proveedor principal de logística' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ example: 'pagos@acme.com.mx' })
  @IsOptional()
  @IsEmail()
  contact_email?: string;

  @ApiPropertyOptional({ example: 'BBVA México' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  bank_name?: string;

  // ── ACH / Wire ──
  @ApiPropertyOptional({ example: '1210002481111' })
  @ValidateIf(o => ['ach', 'wire', 'co_bank_transfer', 'faster_payments'].includes(o.payment_rail))
  @IsNotEmpty()
  @IsString()
  account_number?: string;

  @ApiPropertyOptional({ example: '021000021' })
  @IsOptional()
  @IsString()
  @MinLength(9)
  @MaxLength(9)
  routing_number?: string;

  @ApiPropertyOptional({ enum: ['checking', 'savings', 'electronic_deposit'] })
  @IsOptional()
  @IsEnum(['checking', 'savings', 'electronic_deposit'])
  checking_or_savings?: 'checking' | 'savings' | 'electronic_deposit';

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => BeneficiaryAddressDto)
  address?: BeneficiaryAddressDto;

  // ── SEPA / IBAN ──
  @ApiPropertyOptional({ example: 'DE89370400440532013000' })
  @IsOptional()
  @IsString()
  iban?: string;

  @ApiPropertyOptional({ example: 'COBADEFFXXX' })
  @IsOptional()
  @IsString()
  swift_bic?: string;

  @ApiPropertyOptional({ example: 'NLD' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  iban_country?: string;

  @ApiPropertyOptional({ enum: ['individual', 'business'] })
  @IsOptional()
  @IsEnum(['individual', 'business'])
  account_owner_type?: 'individual' | 'business';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  first_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  last_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  business_name?: string;

  // ── SPEI (México) ──
  @ApiPropertyOptional({ example: '014180655500000007' })
  @ValidateIf(o => o.payment_rail === 'spei')
  @IsNotEmpty()
  @IsString()
  @Matches(/^\d{18}$/, { message: 'CLABE debe tener exactamente 18 dígitos numéricos' })
  clabe?: string;

  // ── PIX (Brasil) ──
  @ApiPropertyOptional({
    description:
      'Requerido si payment_rail es "pix" y no se envía br_code. Debe ser email, CPF (11 dígitos), CNPJ (14 dígitos), teléfono +55 (11 dígitos) o UUID (EVP).',
  })
  @Validate(PixKeyConstraint)
  pix_key?: string;

  @ApiPropertyOptional({
    description: 'Requerido si payment_rail es "pix" y no se envía pix_key (código "copia e cola").',
  })
  @IsOptional()
  @IsString()
  br_code?: string;

  @ApiPropertyOptional({
    description:
      'Para PIX: opcional, pero si se envía debe ser CPF (11 dígitos) o CNPJ (14 dígitos), solo números. Para CO Bank Transfer: requerido.',
  })
  @Validate(DocumentNumberConstraint)
  document_number?: string;

  // ── Bre-B (Colombia) ──
  @ApiPropertyOptional()
  @ValidateIf(o => o.payment_rail === 'bre_b')
  @IsNotEmpty({ message: 'bre_b_key es requerido para Bre-B' })
  @IsString()
  @MinLength(3, { message: 'bre_b_key debe tener al menos 3 caracteres' })
  @MaxLength(140, { message: 'bre_b_key no puede exceder 140 caracteres' })
  bre_b_key?: string;

  // ── FPS — Faster Payments (Reino Unido) ──
  @ApiPropertyOptional({
    example: '123456',
    description: 'Sort code UK, exactamente 6 dígitos sin guiones',
  })
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  sort_code?: string;

  // ── CO Bank Transfer (Colombia) ──
  @ApiPropertyOptional({
    example: '1007',
    description: 'Código del banco colombiano (ColombianBankCode de Bridge)',
    enum: COLOMBIAN_BANK_CODES,
  })
  @ValidateIf(o => o.payment_rail === 'co_bank_transfer')
  @IsNotEmpty({ message: 'bank_code es requerido para CO Bank Transfer' })
  @IsIn([...COLOMBIAN_BANK_CODES], {
    message: `bank_code inválido. Usa uno de los códigos de banco colombiano permitidos por Bridge.`,
  })
  bank_code?: string;

  @ApiPropertyOptional({
    enum: [
      'cc',
      'ce',
      'nit',
      'rut',
      'pa',
      'ppt',
      'ti',
      'rc',
      'te',
      'die',
      'nd',
    ],
  })
  @ValidateIf(o => o.payment_rail === 'co_bank_transfer')
  @IsNotEmpty({ message: 'document_type es requerido para CO Bank Transfer' })
  @IsEnum([
    'cc',
    'ce',
    'nit',
    'rut',
    'pa',
    'ppt',
    'ti',
    'rc',
    'te',
    'die',
    'nd',
  ])
  document_type?: string;

  @ApiPropertyOptional({ example: '+573001234567', description: 'Teléfono en formato E.164' })
  @ValidateIf(o => o.payment_rail === 'co_bank_transfer')
  @IsNotEmpty({ message: 'phone_number es requerido para CO Bank Transfer' })
  @Matches(/^\+\d{7,15}$/, { message: 'phone_number debe estar en formato E.164 (ej. +573001234567)' })
  phone_number?: string;

  // ── Crypto Wallet ──
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  wallet_address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsIn([...ALLOWED_NETWORKS], {
    message: `Red no soportada. Redes permitidas: ${ALLOWED_NETWORKS.join(', ')}`,
  })
  wallet_network?: string;

  @ApiPropertyOptional({
    example: 'usdc',
    enum: [...ALLOWED_CRYPTO_CURRENCIES],
    description:
      'Moneda/token que el proveedor crypto espera recibir (ej. usdc, usdt).',
  })
  @IsOptional()
  @IsString()
  @IsIn([...ALLOWED_CRYPTO_CURRENCIES], {
    message: `Token no soportado. Permitidos: ${ALLOWED_CRYPTO_CURRENCIES.join(', ')}`,
  })
  wallet_currency?: string;
}

export class UpdateSupplierDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  payment_rail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contact_email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bank_name?: string;

  // ACH / Wire
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  account_number?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  routing_number?: string;

  @ApiPropertyOptional({ enum: ['checking', 'savings', 'electronic_deposit'] })
  @IsOptional()
  @IsEnum(['checking', 'savings', 'electronic_deposit'])
  checking_or_savings?: 'checking' | 'savings' | 'electronic_deposit';

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => BeneficiaryAddressDto)
  address?: BeneficiaryAddressDto;

  // SEPA
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iban?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  swift_bic?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  iban_country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(['individual', 'business'])
  account_owner_type?: 'individual' | 'business';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  first_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  last_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  business_name?: string;

  // SPEI
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clabe?: string;

  // PIX
  @ApiPropertyOptional()
  @Validate(PixKeyConstraint)
  pix_key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  br_code?: string;

  @ApiPropertyOptional()
  @Validate(DocumentNumberConstraint)
  document_number?: string;

  // Bre-B
  @ApiPropertyOptional()
  @ValidateIf(o => o.payment_rail === 'bre_b')
  @IsNotEmpty({ message: 'bre_b_key es requerido para Bre-B' })
  @IsString()
  @MinLength(3, { message: 'bre_b_key debe tener al menos 3 caracteres' })
  @MaxLength(140, { message: 'bre_b_key no puede exceder 140 caracteres' })
  bre_b_key?: string;

  // FPS — Faster Payments (Reino Unido)
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  sort_code?: string;

  // CO Bank Transfer (Colombia)
  @ApiPropertyOptional({ enum: COLOMBIAN_BANK_CODES })
  @IsOptional()
  @IsIn([...COLOMBIAN_BANK_CODES], {
    message: `bank_code inválido. Usa uno de los códigos de banco colombiano permitidos por Bridge.`,
  })
  bank_code?: string;

  @ApiPropertyOptional({
    enum: [
      'cc',
      'ce',
      'nit',
      'rut',
      'pa',
      'ppt',
      'ti',
      'rc',
      'te',
      'die',
      'nd',
    ],
  })
  @IsOptional()
  @IsEnum([
    'cc',
    'ce',
    'nit',
    'rut',
    'pa',
    'ppt',
    'ti',
    'rc',
    'te',
    'die',
    'nd',
  ])
  document_type?: string;

  @ApiPropertyOptional({ description: 'Teléfono en formato E.164' })
  @IsOptional()
  @Matches(/^\+\d{7,15}$/, { message: 'phone_number debe estar en formato E.164 (ej. +573001234567)' })
  phone_number?: string;

  // Crypto
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  wallet_address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsIn([...ALLOWED_NETWORKS], {
    message: `Red no soportada. Redes permitidas: ${ALLOWED_NETWORKS.join(', ')}`,
  })
  wallet_network?: string;

  @ApiPropertyOptional({
    example: 'usdc',
    enum: [...ALLOWED_CRYPTO_CURRENCIES],
    description: 'Moneda/token que el proveedor crypto espera recibir.',
  })
  @IsOptional()
  @IsString()
  @IsIn([...ALLOWED_CRYPTO_CURRENCIES], {
    message: `Token no soportado. Permitidos: ${ALLOWED_CRYPTO_CURRENCIES.join(', ')}`,
  })
  wallet_currency?: string;
}

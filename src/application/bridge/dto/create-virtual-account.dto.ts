import {
  IsOptional,
  IsEnum,
  IsUUID,
  IsNumber,
  IsString,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
  MinLength,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBlockchainAddress } from '../validators/is-blockchain-address.validator';

// ═══════════════════════════════════════════════════
//  Virtual Account DTO (depósitos entrantes)
// ═══════════════════════════════════════════════════

/**
 * Monedas fuente soportadas por Bridge para Virtual Accounts.
 * Cada moneda tiene instrucciones de depósito diferentes:
 * - usd → routing_number + account_number (ACH/Wire)
 * - eur → IBAN (SEPA)
 * - mxn → CLABE (SPEI)
 * - brl → br_code (PIX)
 * - gbp → sort_code + account_number (FPS, Beta)
 * - cop → bre_b_key + deposit_message (Bre-B)
 */
const SUPPORTED_SOURCE_CURRENCIES = [
  'usd',
  'eur',
  'mxn',
  'brl',
  'gbp',
  'cop',
] as const;

/**
 * Redes blockchain de destino soportadas por Bridge (OfframpChain).
 * Ref: https://apidocs.bridge.xyz → CreateVirtualAccount schema
 */
export const SUPPORTED_DESTINATION_RAILS = [
  'arbitrum',
  'avalanche_c_chain',
  'base',
  'celo',
  'ethereum',
  'optimism',
  'polygon',
  'solana',
  'stellar',
  'tempo',
  'tron',
] as const;

/**
 * Monedas crypto de destino soportadas por Bridge.
 */
const SUPPORTED_DESTINATION_CURRENCIES = [
  'usdc',
  'usdt',
  'usdb',
  'dai',
  'pyusd',
  'eurc',
] as const;

export class CreateVirtualAccountDto {
  @ApiProperty({
    example: 'usd',
    enum: SUPPORTED_SOURCE_CURRENCIES,
    description:
      'Moneda origen del depósito. Bridge soporta: usd, eur, mxn, brl, gbp',
  })
  @IsEnum(SUPPORTED_SOURCE_CURRENCIES, {
    message: `source_currency debe ser una de: ${SUPPORTED_SOURCE_CURRENCIES.join(', ')}`,
  })
  source_currency: string;

  @ApiProperty({
    example: 'usdc',
    enum: SUPPORTED_DESTINATION_CURRENCIES,
    description:
      'Moneda crypto destino de conversión. Bridge soporta: usdc, usdt, usdb, dai, pyusd, eurc',
  })
  @IsEnum(SUPPORTED_DESTINATION_CURRENCIES, {
    message: `destination_currency debe ser una de: ${SUPPORTED_DESTINATION_CURRENCIES.join(', ')}`,
  })
  destination_currency: string;

  @ApiProperty({
    example: 'ethereum',
    enum: SUPPORTED_DESTINATION_RAILS,
    description:
      'Red blockchain de destino (Bridge OfframpChain). Soporta: ' +
      'arbitrum, avalanche_c_chain, base, celo, ethereum, optimism, polygon, solana, stellar, tempo, tron',
  })
  @IsEnum(SUPPORTED_DESTINATION_RAILS, {
    message: `destination_payment_rail debe ser una de: ${SUPPORTED_DESTINATION_RAILS.join(', ')}`,
  })
  destination_payment_rail: string;

  @ApiPropertyOptional({
    description:
      'Wallet interna de Guira como destino (si los fondos se quedan en plataforma)',
  })
  @IsOptional()
  @IsUUID()
  destination_wallet_id?: string;

  @ApiPropertyOptional({
    description:
      'Dirección de wallet externa (Binance, MetaMask, etc.). Si se proporciona, los fondos se envían fuera de Guira y NO incrementan el balance interno.',
    example: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.destination_address !== undefined)
  @IsBlockchainAddress({
    message:
      'La dirección de wallet no tiene un formato válido. Formatos soportados: EVM (0x...), Solana, Tron, Bitcoin.',
  })
  destination_address?: string;

  @ApiPropertyOptional({
    description: 'Etiqueta descriptiva para la wallet externa',
    example: 'Mi Binance USDC',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  destination_label?: string;
}

// ═══════════════════════════════════════════════════
//  External Account DTOs (cuentas bancarias destino)
// ═══════════════════════════════════════════════════

/**
 * Dirección del beneficiario. Bridge recomienda enviarla para cuentas US
 * y valida con `beneficiary_address_valid` en la respuesta.
 */
export class BeneficiaryAddressDto {
  @ApiProperty({
    example: '123 Main St',
    description: 'Línea de dirección principal (Bridge: 4-35 chars)',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(35)
  street_line_1: string;

  @ApiPropertyOptional({
    example: 'Suite 100',
    description: 'Línea 2 (máx 35 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(35)
  street_line_2?: string;

  @ApiProperty({ example: 'San Francisco' })
  @IsString()
  @IsNotEmpty()
  city: string;

  @ApiPropertyOptional({
    example: 'CA',
    description: 'ISO 3166-2 subdivision code. Requerido para US (máx 3 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  state?: string;

  @ApiPropertyOptional({
    example: '94102',
    description: 'Requerido para países que usan código postal',
  })
  @IsOptional()
  @IsString()
  postal_code?: string;

  @ApiProperty({
    example: 'USA',
    description: 'Código de país ISO 3166-1 alpha-3 (exactamente 3 chars)',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(3)
  country: string;
}

export class CreateExternalAccountDto {
  // ── Campos obligatorios para todas las variantes ──

  @ApiProperty({
    example: 'John Doe',
    description: 'Nombre del titular. Para ACH/Wire: mín 3, máx 35 caracteres.',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(256)
  account_owner_name: string;

  @ApiProperty({
    example: 'usd',
    description: 'Moneda asociada a la cuenta externa',
  })
  @IsString()
  @IsNotEmpty()
  currency: string;

  @ApiProperty({
    example: 'wire',
    enum: [
      'ach',
      'wire',
      'sepa',
      'spei',
      'pix',
      'bre_b',
      'faster_payments',
      'co_bank_transfer',
    ],
    description:
      'Rail de pago. Se usa internamente para derivar el account_type de Bridge (us, iban, clabe, pix, bre_b, gb, co_bank_transfer).',
  })
  @IsEnum([
    'ach',
    'wire',
    'sepa',
    'spei',
    'pix',
    'bre_b',
    'faster_payments',
    'co_bank_transfer',
  ])
  payment_rail: string;

  // ── Campos opcionales globales ──

  @ApiPropertyOptional({
    example: 'Wells Fargo',
    description: 'Nombre del banco',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  bank_name?: string;

  // ── Dirección del beneficiario (recomendada para US) ──

  @ApiPropertyOptional({
    description:
      'Dirección del beneficiario. Bridge recomienda enviarla para cuentas US (ACH/Wire) para validar beneficiary_address_valid.',
    type: () => BeneficiaryAddressDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BeneficiaryAddressDto)
  address?: BeneficiaryAddressDto;

  // ── ACH / Wire (account_type se infiere como "us") ──

  @ApiPropertyOptional({
    example: '021000021',
    description:
      'Routing number (requerido para ACH/Wire). Bridge exige exactamente 9 chars.',
  })
  @IsOptional()
  @IsString()
  @MinLength(9)
  @MaxLength(9)
  routing_number?: string;

  @ApiPropertyOptional({
    example: '1210002481111',
    description:
      'Número de cuenta bancaria. Requerido para ACH/Wire (mín 1 char) y CO Bank Transfer. ' +
      'Para faster_payments debe tener exactamente 8 dígitos (validado en tiempo de ejecución).',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  account_number?: string;

  @ApiPropertyOptional({
    enum: ['checking', 'savings', 'electronic_deposit'],
    description:
      'Tipo de cuenta bancaria. ' +
      'Para ACH/Wire (US): "checking" (default) o "savings". ' +
      'Para CO Bank Transfer (Colombia): "checking", "savings" o "electronic_deposit" — ' +
      'este valor se asigna al campo account.account_type en Bridge, no a checking_or_savings.',
    example: 'checking',
  })
  @IsOptional()
  @IsEnum(['checking', 'savings', 'electronic_deposit'])
  checking_or_savings?: string;

  // ── SEPA / IBAN ──

  @ApiPropertyOptional({
    example: 'DE89370400440532013000',
    description: 'IBAN account number (requerido para SEPA)',
  })
  @IsOptional()
  @IsString()
  iban?: string;

  @ApiPropertyOptional({
    example: 'COBADEFFXXX',
    description: 'SWIFT/BIC code (requerido para SEPA)',
  })
  @IsOptional()
  @IsString()
  swift_bic?: string;

  @ApiPropertyOptional({
    example: 'NLD',
    description:
      'País de la cuenta IBAN (ISO 3166-1 alpha-3, exactamente 3 chars). Requerido por Bridge para cuentas IBAN.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  iban_country?: string;

  @ApiPropertyOptional({
    enum: ['individual', 'business'],
    description:
      'Tipo de titular. Requerido cuando el account_type de Bridge es "iban".',
  })
  @IsOptional()
  @IsEnum(['individual', 'business'])
  account_owner_type?: string;

  @ApiPropertyOptional({
    description:
      'Nombre del titular individual (requerido si account_owner_type = individual)',
  })
  @IsOptional()
  @IsString()
  first_name?: string;

  @ApiPropertyOptional({
    description:
      'Apellido del titular individual (requerido si account_owner_type = individual)',
  })
  @IsOptional()
  @IsString()
  last_name?: string;

  @ApiPropertyOptional({
    description:
      'Nombre de la empresa (requerido si account_owner_type = business)',
  })
  @IsOptional()
  @IsString()
  business_name?: string;

  // ── SPEI (México) ──

  @ApiPropertyOptional({
    example: '014180655500000007',
    description:
      'CLABE interbancaria (requerido para SPEI). Bridge exige exactamente 18 chars.',
  })
  @IsOptional()
  @IsString()
  @MinLength(18)
  @MaxLength(18)
  clabe?: string;

  // ── PIX (Brasil) ── Bridge soporta dos variantes: pix_key O br_code

  @ApiPropertyOptional({
    example: 'joao.silva@email.com',
    description:
      'Clave PIX del destinatario (email, CPF, teléfono, o clave aleatoria). Mutuamente excluyente con br_code.',
  })
  @IsOptional()
  @IsString()
  pix_key?: string;

  @ApiPropertyOptional({
    description:
      'BR Code (código "copia e cola" PIX). Mutuamente excluyente con pix_key.',
  })
  @IsOptional()
  @IsString()
  br_code?: string;

  @ApiPropertyOptional({
    example: '12345678901',
    description:
      'Número de documento del titular PIX (CPF/CNPJ). Opcional para Bridge.',
  })
  @IsOptional()
  @IsString()
  document_number?: string;

  // ── Bre-B (Colombia) ──

  @ApiPropertyOptional({
    example: '1234567890123456',
    description: 'Clave Bre-B para cuentas colombianas (requerido para bre_b).',
  })
  @IsOptional()
  @IsString()
  bre_b_key?: string;

  // ── FPS — Faster Payments (Reino Unido) ──

  @ApiPropertyOptional({
    example: '123456',
    description:
      'Sort code UK, exactamente 6 dígitos sin guiones (requerido para faster_payments).',
  })
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  sort_code?: string;

  // ── CO Bank Transfer (Colombia) ──

  @ApiPropertyOptional({
    example: '1007',
    description:
      'Código del banco colombiano. Ej: 1007 = Bancolombia, 1051 = Davivienda, 1507 = Nequi.',
  })
  @IsOptional()
  @IsString()
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
    description:
      'Tipo de documento del titular (Colombia). cc=Cédula, nit=NIT empresarial, etc.',
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

  @ApiPropertyOptional({
    example: '+573001234567',
    description:
      'Teléfono del titular en formato E.164 (requerido para co_bank_transfer).',
  })
  @IsOptional()
  @IsString()
  phone_number?: string;
}

// ═══════════════════════════════════════════════════
//  Liquidation Address DTO
// ═══════════════════════════════════════════════════

export class CreateLiquidationAddressDto {
  @ApiProperty({ example: 'usdc' })
  @IsString()
  currency: string;

  @ApiProperty({ example: 'ethereum' })
  @IsString()
  chain: string;

  @ApiProperty({ example: 'usd', description: 'Moneda de liquidación fiat' })
  @IsString()
  destination_currency: string;

  @ApiProperty({ example: 'wire' })
  @IsString()
  destination_payment_rail: string;

  @ApiPropertyOptional({ description: 'External account ID de destino' })
  @IsOptional()
  @IsString()
  external_account_id?: string;
}

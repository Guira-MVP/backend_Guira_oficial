import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const LIQUIDATION_CURRENCIES = [
  'usdb',
  'usdc',
  'usdt',
  'dai',
  'pyusd',
  'eurc',
] as const;

const LIQUIDATION_CHAINS = [
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
  'evm',
] as const;

export class CreateLiquidationAddressDto {
  @ApiProperty({ example: 'usdc', enum: LIQUIDATION_CURRENCIES })
  @IsEnum(LIQUIDATION_CURRENCIES, {
    message: `currency debe ser una de: ${LIQUIDATION_CURRENCIES.join(', ')}`,
  })
  currency: string;

  @ApiProperty({ example: 'base', enum: LIQUIDATION_CHAINS })
  @IsEnum(LIQUIDATION_CHAINS, {
    message: `chain debe ser una de: ${LIQUIDATION_CHAINS.join(', ')}`,
  })
  chain: string;

  @ApiProperty({
    example: 'usd',
    description: 'Moneda fiat de liquidación destino',
  })
  @IsString()
  destination_currency: string;

  @ApiProperty({ example: 'wire', description: 'Rail de pago destino' })
  @IsString()
  destination_payment_rail: string;

  @ApiPropertyOptional({
    description: 'ID de external account de Bridge (destino fiat)',
  })
  @IsOptional()
  @IsString()
  external_account_id?: string;

  @ApiPropertyOptional({
    description:
      'Wallet address crypto de destino (para liquidaciones crypto → crypto)',
    example: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
  })
  @IsOptional()
  @IsString()
  destination_address?: string;

  @ApiPropertyOptional({
    description:
      'Referencia SEPA (6-140 chars, solo a-z A-Z 0-9 espacio & - . /). ' +
      'Si no se provee Bridge usa "Payment via Bridge {token}".',
    example: 'Pago via Guira LB9H3K2',
  })
  @IsOptional()
  @IsString()
  destination_sepa_reference?: string;

  @ApiPropertyOptional({
    description:
      'Mensaje Wire (1-140 chars, 4 líneas × 35 chars máx per Fedwire). ' +
      'Incluido en la transferencia wire al beneficiario.',
    example: 'Pago via Guira LB9H3K2',
  })
  @IsOptional()
  @IsString()
  destination_wire_message?: string;

  @ApiPropertyOptional({
    description: 'Referencia ACH (1-10 chars, solo A-Z a-z 0-9 y espacios).',
    example: 'GUIRA',
  })
  @IsOptional()
  @IsString()
  destination_ach_reference?: string;

  @ApiPropertyOptional({
    description:
      'Referencia SPEI (1-40 chars, solo a-z A-Z 0-9 y espacio). ' +
      'Información de remesa incluida en la transferencia SPEI.',
    example: 'Pago Guira LB9H3K2',
  })
  @IsOptional()
  @IsString()
  destination_spei_reference?: string;

  @ApiPropertyOptional({
    description:
      'Referencia genérica para rails modernos (Pix, Faster Payments, Bre-B, CO Bank Transfer).',
    example: 'Pago via Guira LB9H3K2',
  })
  @IsOptional()
  @IsString()
  destination_reference?: string;

  @ApiPropertyOptional({
    description:
      'Fee porcentual del desarrollador a aplicar. Se calcula automáticamente ' +
      'desde fees_config si no se provee. Valor en base 100 (ej. "0.3" = 0.3%).',
    example: '0.3',
  })
  @IsOptional()
  @IsString()
  custom_developer_fee_percent?: string;
}

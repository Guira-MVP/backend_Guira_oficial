import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsNotEmpty,
  IsUUID,
  IsDateString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFeeDto {
  @ApiProperty({
    example: 'payout',
    enum: ['deposit', 'payout', 'transfer', 'fx_conversion'],
  })
  @IsString()
  @IsNotEmpty()
  operation_type: string;

  @ApiProperty({ example: 'wire', enum: ['wire', 'ach', 'crypto', 'sepa'] })
  @IsString()
  @IsNotEmpty()
  payment_rail: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @IsNotEmpty()
  currency: string;

  @ApiProperty({ example: 'mixed', enum: ['percent', 'fixed', 'mixed'] })
  @IsEnum(['percent', 'fixed', 'mixed'])
  fee_type: string;

  @ApiPropertyOptional({ example: 1.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee_percent?: number;

  @ApiPropertyOptional({ example: 5.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee_fixed?: number;

  @ApiPropertyOptional({ example: 2.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  min_fee?: number;

  @ApiPropertyOptional({ example: 100.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  max_fee?: number;

  @ApiPropertyOptional({ example: 'Tarifa estándar para payouts por wire' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateFeeDto {
  @ApiPropertyOptional({ enum: ['percent', 'fixed', 'mixed'] })
  @IsOptional()
  @IsEnum(['percent', 'fixed', 'mixed'])
  fee_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee_percent?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee_fixed?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  min_fee?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  max_fee?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  is_active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class CreateFeeOverrideDto {
  @ApiProperty()
  @IsUUID()
  user_id: string;

  @ApiProperty({
    example: 'ramp_off_bo',
    enum: [
      'interbank_bo_out',
      'interbank_w2w',
      'interbank_bo_wallet',
      'interbank_bo_in',
      'ramp_on_fiat_us',
      'ramp_on_bo',
      'ramp_on_crypto',
      'ramp_off_bo',
      'ramp_off_crypto',
      'ramp_off_fiat_us',
      'wallet_to_fiat_off',
    ],
  })
  @IsIn([
    'interbank_bo_out',
    'interbank_w2w',
    'interbank_bo_wallet',
    'interbank_bo_in',
    'ramp_on_fiat_us',
    'ramp_on_bo',
    'ramp_on_crypto',
    'ramp_off_bo',
    'ramp_off_crypto',
    'ramp_off_fiat_us',
    'wallet_to_fiat_off',
  ])
  operation_type: string;

  @ApiProperty({ example: 'psav', enum: ['psav', 'bridge'] })
  @IsIn(['psav', 'bridge'])
  payment_rail: string;

  @ApiPropertyOptional({ example: 'USD', enum: ['USD', 'BOB', 'USDC', 'USDT'] })
  @IsOptional()
  @IsIn(['USD', 'BOB', 'USDC', 'USDT'])
  currency?: string;

  @ApiProperty({ enum: ['percent', 'fixed', 'mixed'] })
  @IsEnum(['percent', 'fixed', 'mixed'])
  fee_type: string;

  @ApiPropertyOptional({ example: 0.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee_percent?: number;

  @ApiPropertyOptional({ example: 2.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee_fixed?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  min_fee?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  max_fee?: number;

  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @IsDateString()
  valid_from?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsDateString()
  valid_until?: string;

  @ApiPropertyOptional({ example: 'Cliente VIP — tarifa preferencial' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

import {
  IsNumber,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePayoutRequestDto {
  @ApiProperty({ description: 'Wallet fuente' })
  @IsUUID()
  wallet_id: string;

  @ApiPropertyOptional({ description: 'External account destino (Bridge)' })
  @IsOptional()
  @IsUUID()
  bridge_external_account_id?: string;

  @ApiPropertyOptional({ description: 'Supplier destino (alternativo)' })
  @IsOptional()
  @IsUUID()
  supplier_id?: string;

  @ApiProperty({
    example: 'wire',
    enum: ['ach', 'wire', 'sepa', 'spei', 'pix', 'crypto'],
  })
  @IsString()
  @IsNotEmpty()
  payment_rail: string;

  @ApiProperty({ example: 2000.0 })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ example: 'usd' })
  @IsString()
  @IsNotEmpty()
  currency: string;

  @ApiProperty({ example: 'Pago a proveedor — Factura #2026-001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  business_purpose: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

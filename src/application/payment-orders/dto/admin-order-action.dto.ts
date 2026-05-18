import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveOrderDto {
  @ApiPropertyOptional({ example: 6.9 })
  @IsOptional()
  @IsNumber()
  exchange_rate_applied?: number;

  @ApiPropertyOptional({ example: 15.0 })
  @IsOptional()
  @IsNumber()
  fee_final?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class MarkSentDto {
  @ApiProperty({ description: 'Hash de transacción o referencia bancaria' })
  @IsString()
  @IsNotEmpty()
  tx_hash: string;

  @ApiPropertyOptional({ description: 'Referencia interna del PSAV' })
  @IsOptional()
  @IsString()
  provider_reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CompleteOrderDto {
  @ApiPropertyOptional({ description: 'URL del recibo/factura del PSAV' })
  @IsOptional()
  @IsString()
  receipt_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class FailOrderDto {
  @ApiProperty({ description: 'Motivo del fallo' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  notify_user?: boolean;
}

import {
  IsOptional,
  IsNumber,
  IsBoolean,
  IsString,
  IsDateString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateFeeOverrideDto {
  @ApiPropertyOptional({ example: 0.3 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  fee_percent?: number;

  @ApiPropertyOptional({ example: 1.5 })
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

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsDateString()
  valid_until?: string;

  @ApiPropertyOptional({ example: 'Renovación de contrato' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

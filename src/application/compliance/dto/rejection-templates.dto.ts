import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const VALID_CATEGORIES = [
  'in_review',
  'rejected',
  'approved',
  'failed',
  'quote',
  'sent',
  'completed',
] as const;

export class CreateRejectionTemplateDto {
  @ApiProperty({
    enum: VALID_CATEGORIES,
    example: 'in_review',
  })
  @IsString()
  @IsNotEmpty()
  @IsIn(VALID_CATEGORIES)
  category: string;

  @ApiProperty({ example: 'Documento ilegible' })
  @IsString()
  @IsNotEmpty()
  label: string;

  @ApiProperty({
    example:
      'Documento de identidad ilegible, favor resubir en mejor resolución',
  })
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  sort_order?: number;
}

export class UpdateRejectionTemplateDto {
  @ApiPropertyOptional({ example: 'Nuevo label' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiPropertyOptional({ example: 'Nuevo body del template' })
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsInt()
  sort_order?: number;
}

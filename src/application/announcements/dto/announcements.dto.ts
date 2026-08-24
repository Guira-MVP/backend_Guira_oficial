import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsArray,
  IsISO8601,
  IsUrl,
  MaxLength,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Un ítem de la lista del anuncio (p.ej. un país próximo a habilitarse). */
export class AnnouncementItemDto {
  @ApiPropertyOptional({ description: 'Código ISO-2 de país para la bandera', example: 'PE' })
  @IsString()
  @IsOptional()
  @MaxLength(8)
  flag?: string;

  @ApiProperty({ example: 'Perú' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label: string;

  @ApiPropertyOptional({ example: 'Envíos y cobros en soles' })
  @IsString()
  @IsOptional()
  @MaxLength(240)
  description?: string;
}

export class CreateAnnouncementDto {
  @ApiProperty({ example: 'Nuevos rieles en camino' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  title: string;

  @ApiPropertyOptional({ example: 'Próximamente' })
  @IsString()
  @IsOptional()
  @MaxLength(40)
  badge?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  body?: string;

  @ApiPropertyOptional({ type: [AnnouncementItemDto] })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AnnouncementItemDto)
  items?: AnnouncementItemDto[];

  @ApiPropertyOptional({ example: 'Ver detalles' })
  @IsString()
  @IsOptional()
  @MaxLength(60)
  cta_label?: string;

  @ApiPropertyOptional({ example: 'https://guiracorp.com/novedades' })
  @IsUrl({ require_protocol: true })
  @IsOptional()
  cta_url?: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'ISO-8601. NULL = visible desde ya' })
  @IsISO8601()
  @IsOptional()
  publish_at?: string;

  @ApiPropertyOptional({ description: 'ISO-8601. NULL = sin caducidad' })
  @IsISO8601()
  @IsOptional()
  expires_at?: string;
}

export class UpdateAnnouncementDto {
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(40)
  badge?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  body?: string;

  @ApiPropertyOptional({ type: [AnnouncementItemDto] })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => AnnouncementItemDto)
  items?: AnnouncementItemDto[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(60)
  cta_label?: string;

  @ApiPropertyOptional()
  @IsUrl({ require_protocol: true })
  @IsOptional()
  cta_url?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;

  @ApiPropertyOptional()
  @IsISO8601()
  @IsOptional()
  publish_at?: string;

  @ApiPropertyOptional()
  @IsISO8601()
  @IsOptional()
  expires_at?: string;
}

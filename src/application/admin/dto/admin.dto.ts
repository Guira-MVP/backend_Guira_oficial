import {
  IsString,
  IsNotEmpty,
  IsBoolean,
  IsOptional,
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum SettingType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  JSON = 'json',
}

export class UpdateSettingDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  value: string;
}

export class UpdateCurrencySettingDto {
  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_active_va?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_active_supplier?: boolean;
}

export class UpdateVaSourceCurrencySettingDto {
  @ApiPropertyOptional({ description: 'Activar o desactivar esta moneda fiat para depósitos VA' })
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'Activar o desactivar esta moneda/rail fiat para creación de proveedores' })
  @IsBoolean()
  @IsOptional()
  is_active_supplier?: boolean;
}

export class CreateSettingDto extends UpdateSettingDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({ enum: SettingType })
  @IsEnum(SettingType)
  @IsNotEmpty()
  type: SettingType;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  is_public?: boolean;
}

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
  @ApiProperty()
  @IsBoolean()
  is_active: boolean;
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

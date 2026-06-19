import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PartialType } from '@nestjs/mapped-types';

export class CreatePsavDto {
  @ApiProperty({ example: 'Hector Emmanuel Sempertegui Peñaloza', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: 'PSAV-A3F8B2C1', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  verification_code?: string;
}

export class UpdatePsavDto extends PartialType(CreatePsavDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

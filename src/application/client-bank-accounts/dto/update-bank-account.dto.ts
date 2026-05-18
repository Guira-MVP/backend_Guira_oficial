import {
  IsString,
  IsOptional,
  IsEnum,
  IsNotEmpty,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateBankAccountDto {
  @ApiPropertyOptional({ example: 'Banco Nacional de Bolivia' })
  @IsOptional()
  @IsString()
  @MinLength(2, {
    message: 'El nombre del banco debe tener al menos 2 caracteres.',
  })
  @MaxLength(100)
  bank_name?: string;

  @ApiPropertyOptional({ example: '5020-654321-002' })
  @IsOptional()
  @IsString()
  @MinLength(4, {
    message: 'El número de cuenta debe tener al menos 4 caracteres.',
  })
  @MaxLength(50)
  account_number?: string;

  @ApiPropertyOptional({ example: 'María González Pérez' })
  @IsOptional()
  @IsString()
  @MinLength(3, {
    message: 'El nombre del titular debe tener al menos 3 caracteres.',
  })
  @MaxLength(150)
  account_holder?: string;

  @ApiPropertyOptional({ enum: ['savings', 'checking'] })
  @IsOptional()
  @IsEnum(['savings', 'checking'], {
    message: 'El tipo de cuenta debe ser savings o checking.',
  })
  account_type?: string;

  @ApiProperty({
    example:
      'Cambié de banco por mejor tasa de interés y comisiones más bajas.',
    description: 'Motivo obligatorio del cambio. Mínimo 10 caracteres.',
  })
  @IsNotEmpty({ message: 'Debes indicar el motivo del cambio.' })
  @IsString()
  @MinLength(10, { message: 'El motivo debe tener al menos 10 caracteres.' })
  @MaxLength(500)
  change_reason: string;
}

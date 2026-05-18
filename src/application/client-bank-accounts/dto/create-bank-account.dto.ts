import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBankAccountDto {
  @ApiProperty({ example: 'Banco Mercantil Santa Cruz' })
  @IsString()
  @IsNotEmpty({ message: 'El nombre del banco es obligatorio.' })
  @MinLength(2, {
    message: 'El nombre del banco debe tener al menos 2 caracteres.',
  })
  @MaxLength(100)
  bank_name: string;

  @ApiProperty({ example: '4010-123456-001' })
  @IsString()
  @IsNotEmpty({ message: 'El número de cuenta es obligatorio.' })
  @MinLength(4, {
    message: 'El número de cuenta debe tener al menos 4 caracteres.',
  })
  @MaxLength(50)
  account_number: string;

  @ApiProperty({ example: 'María González' })
  @IsString()
  @IsNotEmpty({ message: 'El titular de la cuenta es obligatorio.' })
  @MinLength(3, {
    message: 'El nombre del titular debe tener al menos 3 caracteres.',
  })
  @MaxLength(150)
  account_holder: string;

  @ApiPropertyOptional({ enum: ['savings', 'checking'], default: 'savings' })
  @IsOptional()
  @IsEnum(['savings', 'checking'], {
    message: 'El tipo de cuenta debe ser savings o checking.',
  })
  account_type?: string;
}

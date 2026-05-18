import {
  IsNumber,
  IsString,
  IsNotEmpty,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ManualAdjustmentDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID()
  user_id: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @IsNotEmpty()
  currency: string;

  @ApiProperty({
    example: 150.5,
    description: 'Positivo para crédito, negativo para débito',
  })
  @IsNumber()
  amount: number;

  @ApiProperty({ example: 'Corrección por error de conciliación' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

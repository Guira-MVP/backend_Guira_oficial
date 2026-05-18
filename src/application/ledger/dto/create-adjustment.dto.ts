import {
  IsEnum,
  IsNumber,
  IsString,
  IsNotEmpty,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAdjustmentDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsUUID()
  wallet_id: string;

  @ApiProperty({ enum: ['credit', 'debit'] })
  @IsEnum(['credit', 'debit'])
  type: 'credit' | 'debit';

  @ApiProperty({ example: 250.0 })
  @IsNumber()
  @Min(0.01)
  amount: number;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @IsNotEmpty()
  currency: string;

  @ApiProperty({ example: 'Corrección por depósito no registrado' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ConfirmDepositDto {
  @ApiProperty({ description: 'URL del comprobante de depósito' })
  @IsString()
  @IsNotEmpty()
  deposit_proof_url: string;

  @ApiPropertyOptional({
    description: 'Hash de transacción del depósito (si es crypto)',
  })
  @IsOptional()
  @IsString()
  tx_hash_source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

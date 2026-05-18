import {
  IsOptional,
  IsNumber,
  IsString,
  Min,
  Max,
  MaxLength,
  MinLength,
  IsEnum,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { SUPPORTED_DESTINATION_CURRENCIES } from '../bridge.constants';
import { SUPPORTED_DESTINATION_RAILS } from './create-virtual-account.dto';
import { IsBlockchainAddress } from '../validators/is-blockchain-address.validator';

/**
 * DTO para actualizar una Virtual Account existente.
 * Todos los campos de actualizacion son opcionales (partial update),
 * pero al menos uno debe estar presente.
 * El campo reason es obligatorio para auditoria.
 */
export class UpdateVirtualAccountDto {
  @ApiPropertyOptional({
    description: 'Nuevo developer_fee_percent (0-100)',
    example: 1.5,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  developer_fee_percent?: number;

  @ApiPropertyOptional({
    description:
      'Nueva direccion de destino (wallet blockchain). Bridge permite cambiar a donde se envian los fondos convertidos.',
    example: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(256)
  @ValidateIf((o) => o.destination_address !== undefined)
  @IsBlockchainAddress({
    message:
      'La dirección de wallet no tiene un formato válido. Formatos soportados: EVM (0x...), Solana, Tron, Bitcoin.',
  })
  destination_address?: string;

  @ApiPropertyOptional({
    description: 'Nueva moneda crypto de destino',
    enum: SUPPORTED_DESTINATION_CURRENCIES,
    example: 'usdc',
  })
  @IsOptional()
  @IsEnum(SUPPORTED_DESTINATION_CURRENCIES, {
    message: `destination_currency debe ser una de: ${SUPPORTED_DESTINATION_CURRENCIES.join(', ')}`,
  })
  destination_currency?: string;

  @ApiPropertyOptional({
    description: 'Nueva red crypto de destino',
    enum: SUPPORTED_DESTINATION_RAILS,
    example: 'ethereum',
  })
  @IsOptional()
  @IsEnum(SUPPORTED_DESTINATION_RAILS, {
    message: `destination_payment_rail debe ser una de las redes soportadas.`,
  })
  destination_payment_rail?: string;

  @ApiProperty({
    description: 'Motivo del cambio (requerido para auditoria)',
    example: 'Cliente solicito cambio de wallet destino',
  })
  @IsString()
  @MinLength(5, { message: 'El motivo debe tener al menos 5 caracteres' })
  @MaxLength(500)
  reason: string;
}

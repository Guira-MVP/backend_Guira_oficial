import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// La aprobación NO modifica la cotización (tipo de cambio, fee ni monto destino):
// esos valores quedaron congelados al crear el expediente. Solo permite una nota.
export class ApproveOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ description: 'Evidencia interna del staff (recibo PSAV de recepción del depósito)' })
  @IsOptional()
  @IsString()
  receipt_url?: string;
}

/**
 * Aprobación de la puerta de revisión de staff (pending_review → transfer).
 *
 * Igual que ApproveOrderDto, NO acepta valores financieros: la cotización quedó
 * congelada al crear el expediente y la aprobación solo la honra.
 */
export class ApproveOrderReviewDto {
  @ApiPropertyOptional({
    description:
      'Nota interna del staff sobre la revisión. Queda en notes y en audit_logs.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** Rechazo de la puerta de revisión: cierra el expediente y libera la reserva. */
export class RejectOrderReviewDto {
  @ApiProperty({
    description:
      'Motivo del rechazo. Se muestra al cliente y queda en failure_reason.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  notify_user?: boolean;
}

export class MarkSentDto {
  @ApiProperty({ description: 'Hash de transacción o referencia bancaria' })
  @IsString()
  @IsNotEmpty()
  tx_hash: string;

  @ApiPropertyOptional({ description: 'Referencia interna del PSAV' })
  @IsOptional()
  @IsString()
  provider_reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CompleteOrderDto {
  @ApiPropertyOptional({ description: 'URL del recibo/factura del PSAV' })
  @IsOptional()
  @IsString()
  receipt_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class FailOrderDto {
  @ApiProperty({ description: 'Motivo del fallo' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  notify_user?: boolean;
}

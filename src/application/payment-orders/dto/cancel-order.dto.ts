import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Cancelación iniciada por el cliente desde Operaciones (Expedientes). */
export class CancelOrderDto {
  @ApiPropertyOptional({
    description:
      'Obligatorio en los flujos con depósito fiat en Bolivia: el cliente declara que todavía no realizó el depósito. Sin esta confirmación la cancelación se rechaza, porque el dinero podría estar ya en la cuenta del PSAV sin forma automática de detectarlo.',
  })
  @IsOptional()
  @IsBoolean()
  confirm_no_deposit?: boolean;

  @ApiPropertyOptional({
    description: 'Motivo opcional escrito por el cliente',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Cancelación operativa ejecutada por staff/admin desde el panel. */
export class AdminCancelOrderDto {
  @ApiProperty({
    description: 'Motivo de la cancelación (obligatorio, queda en auditoría)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Si true (default), revierte ledgers pendientes y reembolsa los débitos ya asentados. Poner en false solo cuando la devolución se gestiona por fuera.',
  })
  @IsOptional()
  @IsBoolean()
  refund?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  notify_user?: boolean;
}

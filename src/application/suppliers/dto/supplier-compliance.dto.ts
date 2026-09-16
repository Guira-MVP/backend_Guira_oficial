import { IsIn, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Acción de compliance sobre un beneficiario.
 *
 * `cleared` levanta el bloqueo y también el estado `pending_review` — para el
 * staff son la misma decisión ("este beneficiario está bien"), y tener dos
 * verbos distintos para eso solo invita a errores.
 */
export class SetSupplierComplianceDto {
  @ApiProperty({ enum: ['blocked', 'cleared'] })
  @IsIn(['blocked', 'cleared'])
  status: 'blocked' | 'cleared';

  /**
   * Obligatorio: este estado decide si un cliente puede o no mover dinero, y
   * sin motivo escrito el audit trail no sirve para defender la decisión ante
   * un auditor.
   */
  @ApiProperty({ description: 'Justificación de la decisión (queda en audit_logs)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message: 'La justificación debe explicar la decisión (mínimo 10 caracteres)',
  })
  reason: string;
}

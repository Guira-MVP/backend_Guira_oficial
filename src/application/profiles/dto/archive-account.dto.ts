import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTOs del archivado de cuentas de cliente.
 *
 * Portados desde las Edge Functions `admin-delete-user` y
 * `admin-unarchive-user`, que se retiran. A diferencia de aquellas, aquí el
 * motivo es obligatorio: estas operaciones dejan a alguien sin acceso y deben
 * quedar justificadas en audit_logs.
 */
export class ArchiveAccountDto {
  @ApiProperty({
    enum: ['archive', 'delete'],
    example: 'archive',
    description:
      'archive banea y desactiva (reversible). delete borra definitivamente y solo se admite sin historial de transacciones.',
  })
  @IsIn(['archive', 'delete'], {
    message: 'La acción debe ser "archive" o "delete"',
  })
  action: 'archive' | 'delete';

  @ApiProperty({
    example: 'Cuenta duplicada creada por error en el registro',
    description: 'Motivo de la acción, queda en auditoría',
  })
  @IsString()
  @IsNotEmpty({ message: 'El motivo es requerido' })
  @MaxLength(500)
  reason: string;
}

export class UnarchiveAccountDto {
  @ApiProperty({
    example: 'El titular acreditó su identidad',
    description: 'Motivo de la restauración, queda en auditoría',
  })
  @IsString()
  @IsNotEmpty({ message: 'El motivo es requerido' })
  @MaxLength(500)
  reason: string;
}

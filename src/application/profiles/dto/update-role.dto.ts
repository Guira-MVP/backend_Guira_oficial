import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateRoleDto {
  @ApiProperty({
    example: 'staff',
    description: 'Nuevo rol a asignar al usuario',
    enum: ['client', 'staff', 'admin', 'super_admin'],
  })
  @IsIn(['client', 'staff', 'admin', 'super_admin'], {
    message:
      'Rol inválido. Valores permitidos: client, staff, admin, super_admin',
  })
  role: string;

  @ApiProperty({
    example: 'Promoción a staff por desempeño en soporte',
    description: 'Motivo del cambio de rol (obligatorio para auditoría)',
  })
  @IsString()
  @MinLength(5, { message: 'El motivo debe tener al menos 5 caracteres' })
  @MaxLength(500)
  reason: string;
}

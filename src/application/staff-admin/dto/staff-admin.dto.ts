import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Dominio corporativo. Único origen de verdad en el backend. */
export const STAFF_EMAIL_DOMAIN = '@guiracorp.com';

/** Roles que puede tener el personal interno. `client` no es uno de ellos. */
export const ASSIGNABLE_STAFF_ROLES = [
  'staff',
  'admin',
  'super_admin',
] as const;

export type AssignableStaffRole = (typeof ASSIGNABLE_STAFF_ROLES)[number];

export const STAFF_ROLE_LABELS: Record<AssignableStaffRole, string> = {
  staff: 'Staff',
  admin: 'Administrador',
  super_admin: 'Super administrador',
};

export class InviteStaffDto {
  @ApiProperty({
    example: 'nombre.apellido@guiracorp.com',
    description: `Correo corporativo. Debe pertenecer al dominio ${STAFF_EMAIL_DOMAIN}.`,
  })
  @IsEmail({}, { message: 'Debe ser un email válido' })
  @IsNotEmpty({ message: 'El correo electrónico es requerido' })
  email: string;

  @ApiProperty({
    example: 'Nombre Apellido',
    description: 'Nombre completo de la persona',
  })
  @IsString()
  @IsNotEmpty({ message: 'El nombre completo es requerido' })
  @MinLength(3, { message: 'El nombre completo es demasiado corto' })
  @MaxLength(120, { message: 'El nombre completo es demasiado largo' })
  full_name: string;

  @ApiProperty({
    enum: ASSIGNABLE_STAFF_ROLES,
    example: 'staff',
    description:
      'Rol a asignar. Solo un super_admin puede asignar admin o super_admin.',
  })
  @IsIn(ASSIGNABLE_STAFF_ROLES, { message: 'Rol inválido' })
  role: AssignableStaffRole;

  @ApiProperty({
    example: 'Alta de nueva analista de cumplimiento',
    description: 'Motivo de la invitación, queda en auditoría',
  })
  @IsString()
  @IsNotEmpty({ message: 'El motivo es requerido' })
  @MaxLength(500)
  reason: string;
}

export class UpdateStaffRoleDto {
  @ApiProperty({ enum: ASSIGNABLE_STAFF_ROLES, example: 'admin' })
  @IsIn(ASSIGNABLE_STAFF_ROLES, { message: 'Rol inválido' })
  role: AssignableStaffRole;

  @ApiProperty({ example: 'Promoción a administradora del área' })
  @IsString()
  @IsNotEmpty({ message: 'El motivo es requerido' })
  @MaxLength(500)
  reason: string;
}

export class SetStaffActiveDto {
  @ApiProperty({
    example: false,
    description: 'false desactiva el acceso al panel de forma inmediata',
  })
  @IsBoolean()
  is_active: boolean;

  @ApiProperty({ example: 'Baja del equipo' })
  @IsString()
  @IsNotEmpty({ message: 'El motivo es requerido' })
  @MaxLength(500)
  reason: string;
}

export class ResendStaffInviteDto {
  @ApiProperty({ example: 'El enlace anterior caducó' })
  @IsString()
  @IsNotEmpty({ message: 'El motivo es requerido' })
  @MaxLength(500)
  reason: string;
}

export interface StaffMemberResponse {
  id: string;
  email: string;
  full_name: string;
  role: AssignableStaffRole;
  is_active: boolean;
  invited_by: string | null;
  invited_at: string;
  activated_at: string | null;
  created_at: string;
}

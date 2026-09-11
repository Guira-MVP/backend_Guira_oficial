import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CAPABILITIES,
  PRESETS,
} from '../../../common/constants/capabilities.constants';
import type {
  Capability,
  Preset,
} from '../../../common/constants/capabilities.constants';

/**
 * Tope de miembros activos por cuenta. No es una barrera de seguridad —el
 * guard no depende de esto— sino un freno a invitaciones masivas y una
 * forma de que un uso anómalo se note.
 */
export const MAX_ACTIVE_MEMBERS = 20;

export class InviteMemberDto {
  @ApiProperty({ example: 'contabilidad@miempresa.com' })
  @IsEmail({}, { message: 'Debe ser un email válido' })
  @IsNotEmpty({ message: 'El correo electrónico es requerido' })
  email: string;

  @ApiProperty({ example: 'Ana Pérez' })
  @IsString()
  @IsNotEmpty({ message: 'El nombre completo es requerido' })
  @MinLength(3, { message: 'El nombre completo es demasiado corto' })
  @MaxLength(120, { message: 'El nombre completo es demasiado largo' })
  full_name: string;

  @ApiProperty({
    enum: PRESETS,
    example: 'finance',
    description:
      'Plantilla de permisos. Con "custom" se usan los de `capabilities`; ' +
      'con el resto, los de la plantilla (lo que venga en `capabilities` se ignora).',
  })
  @IsIn(PRESETS, { message: 'Plantilla de permisos inválida' })
  preset: Preset;

  @ApiPropertyOptional({
    isArray: true,
    enum: CAPABILITIES,
    description: 'Solo se tiene en cuenta cuando `preset` es "custom".',
  })
  @ValidateIf((dto: InviteMemberDto) => dto.preset === 'custom')
  @IsArray()
  @ArrayMaxSize(CAPABILITIES.length)
  @IsIn(CAPABILITIES, {
    each: true,
    message: 'Permiso desconocido',
  })
  capabilities?: Capability[];
}

export class UpdateMemberCapabilitiesDto {
  @ApiProperty({ enum: PRESETS, example: 'custom' })
  @IsIn(PRESETS, { message: 'Plantilla de permisos inválida' })
  preset: Preset;

  @ApiPropertyOptional({ isArray: true, enum: CAPABILITIES })
  @ValidateIf((dto: UpdateMemberCapabilitiesDto) => dto.preset === 'custom')
  @IsArray()
  @ArrayMaxSize(CAPABILITIES.length)
  @IsIn(CAPABILITIES, { each: true, message: 'Permiso desconocido' })
  capabilities?: Capability[];

  @ApiPropertyOptional({ example: 'Se suma al cierre contable mensual' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RevokeMemberDto {
  @ApiProperty({ example: 'Dejó la empresa' })
  @IsString()
  @IsNotEmpty({ message: 'El motivo es requerido' })
  @MaxLength(500)
  reason: string;
}

export class AcceptInvitationDto {
  @ApiProperty({ description: 'Token recibido por correo' })
  @IsString()
  @IsNotEmpty({ message: 'El token es requerido' })
  token: string;
}

export interface AccountMemberResponse {
  id: string;
  member_id: string | null;
  invited_email: string;
  full_name: string | null;
  preset: Preset;
  capabilities: Capability[];
  status: string;
  invited_at: string;
  accepted_at: string | null;
}

/** Cuenta a la que un usuario tiene acceso vinculado. Alimenta el selector. */
export interface LinkedAccountResponse {
  owner_id: string;
  company_name: string | null;
  preset: Preset;
  capabilities: Capability[];
}

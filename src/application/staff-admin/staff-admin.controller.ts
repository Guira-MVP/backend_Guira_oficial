import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StaffAdminService } from './staff-admin.service';
import {
  InviteStaffDto,
  ResendStaffInviteDto,
  SetStaffActiveDto,
  UpdateStaffRoleDto,
} from './dto/staff-admin.dto';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';

/**
 * Gestión del personal interno del panel.
 *
 * Sustituye a las Edge Functions admin-create-user / admin-delete-user /
 * admin-unarchive-user / admin-reset-password, que permitían crear una cuenta
 * con rol super_admin y contraseña arbitraria sin ninguna validación de
 * dominio. Aquí todo pasa por RolesGuard y queda en audit_logs.
 *
 * Este controller NO crea cuentas de cliente: los clientes se registran por el
 * flujo público.
 */
@ApiTags('Staff Admin')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/staff')
@UseGuards(RolesGuard)
@Roles('admin', 'super_admin')
export class StaffAdminController {
  constructor(private readonly staffAdminService: StaffAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar el personal interno',
    description:
      'Devuelve todo el personal con acceso al panel, su rol y su estado.',
  })
  @ApiResponse({ status: 200, description: 'Listado de personal' })
  @ApiResponse({ status: 403, description: 'Permisos insuficientes' })
  async list() {
    return this.staffAdminService.list();
  }

  @Post('invite')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invitar a una persona al panel',
    description:
      'Crea la cuenta sin contraseña y envía un enlace para que su titular la defina. Solo admite correos @guiracorp.com.',
  })
  @ApiResponse({ status: 201, description: 'Invitación enviada' })
  @ApiResponse({ status: 400, description: 'Dominio o rol inválido' })
  @ApiResponse({
    status: 409,
    description: 'Ya existe una cuenta con ese correo',
  })
  async invite(
    @Body() dto: InviteStaffDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.staffAdminService.invite(dto, actor);
  }

  @Post(':id/resend-invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reenviar el enlace de acceso',
    description: 'Genera un enlace nuevo, por ejemplo si el anterior caducó.',
  })
  @ApiResponse({ status: 200, description: 'Enlace reenviado' })
  @ApiResponse({ status: 404, description: 'Personal no encontrado' })
  async resendInvite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResendStaffInviteDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.staffAdminService.resendInvite(id, dto, actor);
  }

  @Patch(':id/role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cambiar el rol de un miembro del personal',
    description:
      'Solo un super_admin puede asignar o modificar los roles admin y super_admin. Nadie puede cambiar su propio rol.',
  })
  @ApiResponse({ status: 200, description: 'Rol actualizado' })
  @ApiResponse({ status: 400, description: 'Operación no permitida' })
  async updateRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStaffRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.staffAdminService.updateRole(id, dto, actor);
  }

  @Patch(':id/active')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activar o desactivar el acceso al panel',
    description:
      'Desactivar revoca las sesiones abiertas de inmediato. No se elimina el registro, para conservar la trazabilidad.',
  })
  @ApiResponse({ status: 200, description: 'Estado actualizado' })
  @ApiResponse({ status: 400, description: 'Operación no permitida' })
  async setActive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetStaffActiveDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.staffAdminService.setActive(id, dto, actor);
  }
}

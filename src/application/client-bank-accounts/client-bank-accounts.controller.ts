import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { ClientBankAccountsService } from './client-bank-accounts.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { UpdateBankAccountDto } from './dto/update-bank-account.dto';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

// ─────────────────────────────────────────────────────
//  Rutas de usuario autenticado: /client-bank-accounts/...
// ─────────────────────────────────────────────────────

@ApiTags('Client Bank Accounts')
@ApiBearerAuth('supabase-jwt')
@Controller('client-bank-accounts')
export class ClientBankAccountsController {
  constructor(private readonly service: ClientBankAccountsService) {}

  @Post()
  @ApiOperation({
    summary: 'Registrar cuenta bancaria (Bolivia)',
    description:
      'Registra la cuenta bancaria personal del cliente para retiros. Solo disponible para usuarios con KYC/KYB aprobado.',
  })
  @ApiResponse({ status: 201, description: 'Cuenta bancaria registrada' })
  @ApiResponse({
    status: 400,
    description: 'Ya tiene cuenta registrada o datos inválidos',
  })
  @ApiResponse({ status: 403, description: 'Usuario no aprobado' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBankAccountDto,
  ) {
    return this.service.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar mis cuentas bancarias' })
  @ApiResponse({ status: 200, description: 'Lista de cuentas bancarias' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.service.findByUser(user.id);
  }

  @Get('primary')
  @ApiOperation({
    summary: 'Obtener cuenta bancaria primaria',
    description:
      'Retorna la cuenta bancaria BOB primaria del usuario, o null si no tiene.',
  })
  @ApiResponse({ status: 200, description: 'Cuenta primaria o null' })
  findPrimary(@CurrentUser() user: AuthenticatedUser) {
    return this.service.findPrimary(user.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Solicitar actualización de cuenta bancaria',
    description:
      'Los cambios quedan pendientes de aprobación por un miembro del staff. Límite: 1 cambio por mes calendario. Requiere motivo obligatorio.',
  })
  @ApiResponse({ status: 200, description: 'Solicitud de cambio registrada' })
  @ApiResponse({ status: 404, description: 'Cuenta no encontrada' })
  @ApiResponse({
    status: 400,
    description: 'Rate limit excedido o cambio pendiente',
  })
  requestUpdate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateBankAccountDto,
  ) {
    return this.service.requestUpdate(user.id, id, dto);
  }
}

// ─────────────────────────────────────────────────────
//  Rutas de administración: /admin/client-bank-accounts/...
// ─────────────────────────────────────────────────────

@ApiTags('Admin — Client Bank Accounts')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/client-bank-accounts')
@UseGuards(RolesGuard)
export class AdminClientBankAccountsController {
  constructor(private readonly service: ClientBankAccountsService) {}

  @Get('pending')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Listar cuentas con cambios pendientes de aprobación',
  })
  @ApiResponse({ status: 200, description: 'Lista de cuentas pendientes' })
  listPending() {
    return this.service.listPendingApprovals();
  }

  @Get('user/:userId')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Ver cuentas bancarias de un usuario' })
  @ApiResponse({ status: 200, description: 'Cuentas del usuario' })
  findByUser(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.service.findByUserAdmin(userId);
  }

  @Patch(':id/approve')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Aprobar cambios pendientes en cuenta bancaria',
  })
  @ApiResponse({ status: 200, description: 'Cambio aprobado' })
  approveChange(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.approveChange(id, actor.id, actor.profile.role);
  }

  @Patch(':id/reject')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Rechazar cambios pendientes en cuenta bancaria',
  })
  @ApiResponse({ status: 200, description: 'Cambio rechazado' })
  rejectChange(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body('reason') reason?: string,
  ) {
    return this.service.rejectChange(id, actor.id, actor.profile.role, reason);
  }
}

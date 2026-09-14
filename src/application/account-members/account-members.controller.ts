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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AccountMembersService } from './account-members.service';
import {
  AcceptInvitationDto,
  InviteMemberDto,
  ReopenInvitationDto,
  RevokeMemberDto,
  UpdateMemberCapabilitiesDto,
} from './dto/account-members.dto';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { Roles } from '../../core/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  HIGH_SENSITIVITY_CAPABILITIES,
  PRESET_CAPABILITIES,
  PRESET_LABELS,
} from '../../common/constants/capabilities.constants';

/**
 * Equipo interno de una cuenta cliente.
 *
 * Ningún endpoint de este controller declara @RequiresCapability, y eso es
 * intencional: significa que LinkedAccessGuard los bloquea en modo
 * vinculado. Un miembro del equipo no puede invitar a más gente ni tocar
 * los permisos de nadie, ni siquiera los suyos.
 */
@ApiTags('Equipo de la cuenta')
@ApiBearerAuth('supabase-jwt')
@Controller('account-members')
export class AccountMembersController {
  constructor(private readonly service: AccountMembersService) {}

  // ── Catálogo ─────────────────────────────────

  @Get('catalog')
  @ApiOperation({
    summary: 'Catálogo de permisos y plantillas disponibles',
    description:
      'Lo consume la pantalla de invitación para pintar las opciones sin ' +
      'duplicar la lista en el frontend.',
  })
  getCatalog() {
    return {
      capabilities: CAPABILITIES.map((key) => ({
        key,
        label: CAPABILITY_LABELS[key],
        high_sensitivity: HIGH_SENSITIVITY_CAPABILITIES.includes(key),
      })),
      presets: [
        {
          key: 'operations',
          label: PRESET_LABELS.operations,
          capabilities: PRESET_CAPABILITIES.operations,
        },
        {
          key: 'finance',
          label: PRESET_LABELS.finance,
          capabilities: PRESET_CAPABILITIES.finance,
        },
        { key: 'custom', label: PRESET_LABELS.custom, capabilities: [] },
      ],
    };
  }

  // ── Lado del titular ─────────────────────────

  @Get()
  @Roles('client')
  @ApiOperation({ summary: 'Listar el equipo de mi cuenta' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.list(user.id);
  }

  @Post('invite')
  @Roles('client')
  @ApiOperation({ summary: 'Invitar a una persona a mi equipo' })
  @ApiResponse({ status: 201, description: 'Invitación creada' })
  @ApiResponse({ status: 400, description: 'Datos inválidos o tope alcanzado' })
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteMemberDto,
  ) {
    return this.service.invite(user, dto);
  }

  @Patch(':id/capabilities')
  @Roles('client')
  @ApiOperation({
    summary: 'Cambiar los permisos de un miembro',
    description: 'Surte efecto en la siguiente petición de esa persona.',
  })
  updateCapabilities(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateMemberCapabilitiesDto,
  ) {
    return this.service.updateCapabilities(user, id, dto);
  }

  @Post(':id/revoke')
  @Roles('client')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retirar el acceso de un miembro',
    description: 'Efecto inmediato: no hay caché ni nada guardado en el token.',
  })
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RevokeMemberDto,
  ) {
    return this.service.revoke(user, id, dto.reason);
  }

  @Post(':id/reopen')
  @Roles('client')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reenviar o volver a invitar sobre la misma fila',
    description:
      'Genera un token nuevo y renueva el plazo. Sin `preset` conserva los ' +
      'permisos actuales (reenviar); con `preset` los reemplaza (volver a ' +
      'invitar a alguien cuyo acceso se retiró).',
  })
  @ApiResponse({ status: 429, description: 'Límite de envíos alcanzado' })
  reopen(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReopenInvitationDto,
  ) {
    return this.service.reopen(user, id, dto);
  }

  // ── Lado del invitado ────────────────────────

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aceptar una invitación recibida por correo' })
  @ApiResponse({ status: 403, description: 'La invitación es para otro correo' })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AcceptInvitationDto,
  ) {
    return this.service.accept(user, dto.token);
  }

  @Get('my-access')
  @ApiOperation({
    summary: 'Cuentas que puedo consultar',
    description: 'Alimenta el selector de cuenta del panel.',
  })
  myAccess(@CurrentUser() user: AuthenticatedUser) {
    return this.service.myLinkedAccounts(user.id);
  }
}

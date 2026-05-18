import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  DefaultValuePipe,
  ParseIntPipe,
  ParseBoolPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { ProfilesService } from './profiles.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { FreezeAccountDto, ActivateAccountDto } from './dto/freeze-account.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

// ─────────────────────────────────────────────────────
//  Rutas de usuario autenticado: /profiles/...
// ─────────────────────────────────────────────────────

@ApiTags('Profiles')
@ApiBearerAuth('supabase-jwt')
@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get('me')
  @ApiOperation({ summary: 'Obtener perfil del usuario autenticado' })
  @ApiResponse({ status: 200, description: 'Perfil completo del usuario' })
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.profilesService.findOne(user.id);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Actualizar perfil (nombre, teléfono, avatar_url)',
  })
  @ApiResponse({ status: 200, description: 'Perfil actualizado' })
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profilesService.update(user.id, dto);
  }

  @Get('me/onboarding-status')
  @ApiOperation({ summary: 'Obtener estado de onboarding resumido' })
  @ApiResponse({
    status: 200,
    description: 'Estado de onboarding y cuenta Bridge',
  })
  getOnboardingStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.profilesService.getOnboardingStatus(user.id);
  }

  @Get('me/avatar-upload-url')
  @ApiOperation({ summary: 'Obtener URL firmada para subir avatar' })
  @ApiResponse({ status: 200, description: 'URL firmada para upload' })
  getAvatarUploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Query('fileName') fileName: string,
  ) {
    return this.profilesService.getAvatarUploadUrl(user.id, fileName);
  }
}

// ─────────────────────────────────────────────────────
//  Rutas de administración: /admin/profiles/...
// ─────────────────────────────────────────────────────

@ApiTags('Admin — Profiles')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/profiles')
@UseGuards(RolesGuard)
export class AdminProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar todos los perfiles (paginado)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: ['client', 'staff', 'admin', 'super_admin'],
  })
  @ApiQuery({
    name: 'onboarding_status',
    required: false,
    enum: ['pending', 'in_review', 'approved', 'rejected'],
  })
  @ApiQuery({ name: 'is_frozen', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Lista paginada de perfiles' })
  findAll(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('role') role?: string,
    @Query('onboarding_status') onboardingStatus?: string,
    @Query('is_frozen') isFrozen?: string,
  ) {
    return this.profilesService.findAll(page, Math.min(limit, 100), {
      role,
      onboarding_status: onboardingStatus,
      is_frozen:
        isFrozen === 'true' ? true : isFrozen === 'false' ? false : undefined,
    });
  }

  @Get(':id')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Ver perfil completo de un usuario' })
  @ApiResponse({ status: 200, description: 'Perfil completo' })
  @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
  findById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.profilesService.findById(id);
  }

  @Patch(':id/freeze')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Congelar o descongelar una cuenta de usuario' })
  @ApiResponse({ status: 200, description: 'Cuenta congelada/descongelada' })
  @ApiResponse({ status: 400, description: 'Motivo requerido al congelar' })
  freezeAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: FreezeAccountDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.profilesService.freezeAccount(
      id,
      dto.freeze,
      dto.reason,
      actor.id,
    );
  }

  @Patch(':id/activate')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Activar o desactivar una cuenta de usuario' })
  @ApiResponse({ status: 200, description: 'Cuenta activada/desactivada' })
  activateAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ActivateAccountDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.profilesService.toggleActive(id, dto.is_active, actor.id);
  }

  @Patch(':id/role')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Cambiar el rol de un usuario' })
  @ApiResponse({ status: 200, description: 'Rol actualizado' })
  @ApiResponse({ status: 400, description: 'Operación no permitida' })
  updateRole(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.profilesService.updateRole(id, dto.role, dto.reason, actor);
  }
}

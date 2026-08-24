import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';

import { AnnouncementsService } from './announcements.service';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcements.dto';

// ── LECTURA DEL CLIENTE ────────────────────────────────────────────

@ApiTags('Announcements')
@ApiBearerAuth('supabase-jwt')
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Get('active')
  @ApiOperation({ summary: 'Anuncio vigente para mostrar al iniciar sesión' })
  getActive() {
    return this.announcementsService.getActiveForClient();
  }
}

// ── GESTIÓN DEL STAFF ──────────────────────────────────────────────

@ApiTags('Admin - Announcements')
@ApiBearerAuth('supabase-jwt')
@UseGuards(RolesGuard)
@Controller('admin/announcements')
export class AnnouncementsAdminController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Get()
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar todos los anuncios' })
  list() {
    return this.announcementsService.list();
  }

  @Post()
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Crear un anuncio' })
  create(
    @Body() dto: CreateAnnouncementDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.announcementsService.create(dto, user.id, user.profile.role);
  }

  @Patch(':id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Actualizar un anuncio' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAnnouncementDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.announcementsService.update(id, dto, user.id, user.profile.role);
  }

  @Delete(':id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Eliminar un anuncio' })
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.announcementsService.remove(id, user.id, user.profile.role);
  }
}

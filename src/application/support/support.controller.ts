import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import type { User } from '@supabase/supabase-js';

import { SupportService } from './support.service';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import {
  CreateTicketDto,
  AssignTicketDto,
  ResolveTicketDto,
  UpdateTicketStatusDto,
} from './dto/support.dto';

// ── ENDPOINTS DE USUARIO ──────────────────────────────────────────

@ApiTags('Support - Tickets')
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  @Post()
  @ApiBearerAuth('supabase-jwt')
  @ApiOperation({ summary: 'Crear un nuevo ticket de soporte' })
  createTicket(@Body() dto: CreateTicketDto, @CurrentUser() user: User) {
    // Si el usuario no manda auth se puede permitir omitiendo ApiBearerAuth y validando manual,
    // pero para M-Guira lo dejaremos protegido por ahora:
    return this.supportService.createTicket(dto, user?.id);
  }

  @Get()
  @ApiBearerAuth('supabase-jwt')
  @ApiOperation({ summary: 'Listar mis tickets' })
  getMyTickets(@CurrentUser() user: User) {
    return this.supportService.getUserTickets(user.id);
  }

  @Get(':id')
  @ApiBearerAuth('supabase-jwt')
  @ApiOperation({ summary: 'Ver detalle de un ticket' })
  getTicket(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    return this.supportService.getTicket(id, user.id);
  }
}

// ── ENDPOINTS DE ADMINISTRACIÓN ───────────────────────────────────

@ApiTags('Admin — Support')
@ApiBearerAuth('supabase-jwt')
@UseGuards(RolesGuard)
@Controller('admin/support/tickets')
export class AdminSupportController {
  constructor(private readonly supportService: SupportService) {}

  @Get()
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar todos los tickets (Staff)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'assigned_to', required: false })
  @ApiQuery({ name: 'page', required: false })
  getAllTickets(
    @Query('status') status?: string,
    @Query('assigned_to') assignedTo?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
  ) {
    const filters: Record<string, string> = {};
    if (status) filters.status = status;
    if (assignedTo) filters.assigned_to = assignedTo;

    return this.supportService.getAllTickets(filters, page ?? 1);
  }

  @Patch(':id/assign')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Asignar un ticket a un agente' })
  assignTicket(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignTicketDto,
    @CurrentUser() user: User,
  ) {
    return this.supportService.assignTicket(id, dto, user.id);
  }

  @Patch(':id/status')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Cambiar el estado de un ticket' })
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTicketStatusDto,
    @CurrentUser() user: User,
  ) {
    return this.supportService.updateStatus(id, dto, user.id);
  }

  @Patch(':id/resolve')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Marcar ticket como resuelto' })
  resolveTicket(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveTicketDto,
    @CurrentUser() user: User,
  ) {
    return this.supportService.resolveTicket(id, dto, user.id);
  }
}

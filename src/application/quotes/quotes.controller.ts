import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';

import { QuotesService } from './quotes.service';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import { CreateQuoteDto } from './dto/quotes.dto';

@ApiTags('Admin — Quotes')
@ApiBearerAuth('supabase-jwt')
@UseGuards(RolesGuard)
@Controller('admin/quotes')
export class QuotesController {
  constructor(private readonly quotesService: QuotesService) {}

  @Get()
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Historial de cotizaciones generadas por el staff' })
  list(
    @Query('phone') phone?: string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to') dateTo?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.quotesService.list({
      phone,
      date_from: dateFrom,
      date_to: dateTo,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(':id')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Detalle de una cotización' })
  getById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.quotesService.getById(id);
  }

  @Post()
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Generar y guardar una nueva cotización para un prospecto' })
  create(@Body() dto: CreateQuoteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.quotesService.create(
      dto,
      user.id,
      user.profile.full_name ?? user.email,
      user.profile.role,
    );
  }
}

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  DefaultValuePipe,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { LedgerService } from './ledger.service';
import { CreateAdjustmentDto } from './dto/create-adjustment.dto';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

// ─────────────────────────────────────────────────
//  Rutas de usuario: /ledger/...
// ─────────────────────────────────────────────────

@ApiTags('Ledger')
@ApiBearerAuth('supabase-jwt')
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get()
  @ApiOperation({ summary: 'Historial de movimientos del usuario' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date start' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date end' })
  @ApiQuery({ name: 'type', required: false, enum: ['credit', 'debit'] })
  @ApiQuery({ name: 'currency', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['pending', 'settled', 'failed', 'reversed'],
  })
  @ApiResponse({ status: 200, description: 'Historial paginado' })
  getHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('type') type?: string,
    @Query('currency') currency?: string,
    @Query('status') status?: string,
  ) {
    return this.ledgerService.getHistory(
      user.id,
      { from, to, type, currency, status },
      page,
      limit,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una entrada del ledger' })
  @ApiResponse({ status: 200, description: 'Entrada del ledger' })
  @ApiResponse({ status: 404, description: 'No encontrada' })
  getEntry(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ledgerService.getEntry(id, user.id);
  }
}

// ─────────────────────────────────────────────────
//  Rutas admin: /admin/ledger/...
// ─────────────────────────────────────────────────

@ApiTags('Admin — Ledger')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/ledger')
@UseGuards(RolesGuard)
export class AdminLedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Post('adjustment')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Ajuste manual de ledger con justificación' })
  @ApiResponse({ status: 201, description: 'Ajuste creado' })
  createAdjustment(
    @Body() dto: CreateAdjustmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.ledgerService.createAdjustment(
      dto.wallet_id,
      dto.type,
      dto.amount,
      dto.currency,
      dto.reason,
      actor.id,
    );
  }
}

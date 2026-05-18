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

import { AdminService } from './admin.service';
import { ReconciliationService } from './reconciliation.service';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import { CreateSettingDto, UpdateSettingDto, UpdateCurrencySettingDto } from './dto/admin.dto';

// ── SETTINGS PÚBLICOS (Require auth, retorna solo settings con is_public=true) ──

@ApiTags('Settings')
@Controller('settings')
export class PublicSettingsController {
  constructor(private readonly adminService: AdminService) {}

  @Get('public')
  @ApiOperation({ summary: 'Obtener configuración pública de la app' })
  getPublicSettings() {
    return this.adminService.getPublicSettings();
  }

  @Get('currencies')
  @ApiOperation({ summary: 'Obtener divisas activas (requiere auth)' })
  getActiveCurrencies() {
    return this.adminService.getActiveCurrencies();
  }
}

// ── ACTIVITY FEED (Auth de Usuario) ────────────────────────────────

@ApiTags('Activity')
@ApiBearerAuth('supabase-jwt')
@Controller('activity')
export class ActivityController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @ApiOperation({ summary: 'Feed de actividad del usuario logueado' })
  @ApiQuery({ name: 'limit', required: false })
  getMyActivity(
    @CurrentUser() user: User,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.adminService.getUserActivityLogs(user.id, limit);
  }
}

// ── ADMIN ROUTES (Protegidos por RolesGuard) ────────────────────────

@ApiTags('Admin — Panel')
@ApiBearerAuth('supabase-jwt')
@UseGuards(RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  // ── APP SETTINGS ─────────────────────────────

  @Get('settings')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Listar todos los settings (App Config)' })
  getAllSettings() {
    return this.adminService.getAllSettings();
  }

  @Post('settings')
  @Roles('super_admin')
  @ApiOperation({ summary: 'Crear nuevo setting' })
  createSetting(@Body() dto: CreateSettingDto, @CurrentUser() user: User) {
    return this.adminService.createSetting(dto, user.id);
  }

  @Patch('settings/:key')
  @Roles('super_admin')
  @ApiOperation({ summary: 'Actualizar un setting existente' })
  updateSetting(
    @Param('key') key: string,
    @Body() dto: UpdateSettingDto,
    @CurrentUser() user: User,
  ) {
    return this.adminService.updateSetting(key, dto, user.id);
  }

  // ── CURRENCY SETTINGS ────────────────────────

  @Get('currency-settings')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Listar configuración de divisas' })
  getCurrencySettings() {
    return this.adminService.getCurrencySettings();
  }

  @Patch('currency-settings/:currency')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Activar o desactivar una divisa' })
  updateCurrencySetting(
    @Param('currency') currency: string,
    @Body() dto: UpdateCurrencySettingDto,
    @CurrentUser() user: User,
  ) {
    return this.adminService.updateCurrencySetting(currency, dto, user.id);
  }

  // ── AUDIT LOGS ───────────────────────────────

  @Get('audit-logs')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Historial de auditoría completo' })
  @ApiQuery({ name: 'performed_by', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'table_name', required: false })
  @ApiQuery({ name: 'page', required: false })
  getAuditLogs(
    @Query('performed_by') performedBy?: string,
    @Query('action') action?: string,
    @Query('table_name') tableName?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
  ) {
    const filters: Record<string, string> = {};
    if (performedBy) filters.performed_by = performedBy;
    if (action) filters.action = action;
    if (tableName) filters.table_name = tableName;
    return this.adminService.getAuditLogs(filters, page ?? 1);
  }

  @Get('audit-logs/user/:userId')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Audit logs realizados por un usuario específico' })
  getUserAudit(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.adminService.getUserAuditLogs(userId);
  }

  // ── ACTIVITY LOGS (STAFF) ────────────────────

  @Get('activity/:userId')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Ver actividad del cliente (Vista Staff)' })
  getActivityForAdmin(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.adminService.getUserActivityLogs(userId, 100);
  }

  // ── RECONCILIATION ───────────────────────────

  @Post('reconciliation/run')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Ejecutar proceso manual de reconciliación financiera',
  })
  runReconciliation(@CurrentUser() user: User) {
    return this.reconciliationService.runReconciliation(user.id);
  }

  @Get('reconciliation')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Historial de procesos de reconciliación' })
  @ApiQuery({ name: 'page', required: false })
  getReconciliations(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.reconciliationService.getReconciliationHistory(page);
  }

  @Get('reconciliation/:id')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Detalle e informe de discrepancias de una reconciliación',
  })
  getReconciliationDetail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.reconciliationService.getReconciliationDetail(id);
  }
}

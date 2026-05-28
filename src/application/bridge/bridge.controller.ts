import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BridgeService } from './bridge.service';
import { VA_THROTTLE_CONFIG } from './bridge.constants';
import { CreatePayoutRequestDto } from './dto/create-payout.dto';
import {
  CreateVirtualAccountDto,
  CreateExternalAccountDto,
} from './dto/create-virtual-account.dto';
import { CreateLiquidationAddressDto } from './dto/create-liquidation-address.dto';
import { UpdateVirtualAccountDto } from './dto/update-virtual-account.dto';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

// ─────────────────────────────────────────────────
//  Rutas de usuario: /bridge/...
// ─────────────────────────────────────────────────

@ApiTags('Bridge')
@ApiBearerAuth('supabase-jwt')
@Controller('bridge')
export class BridgeController {
  constructor(private readonly bridgeService: BridgeService) {}

  // ── Virtual Accounts ──────────────────

  @Post('virtual-accounts')
  @Throttle({
    default: { limit: VA_THROTTLE_CONFIG.limit, ttl: VA_THROTTLE_CONFIG.ttl },
  })
  @ApiOperation({
    summary: 'Crear Virtual Account para recepción de depósitos',
  })
  @ApiResponse({
    status: 201,
    description: 'VA creada con instrucciones bancarias',
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit excedido — máximo 6 creaciones de VA cada 10 minutos',
  })
  createVirtualAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVirtualAccountDto,
  ) {
    return this.bridgeService.createVirtualAccount(user.id, dto);
  }

  @Get('virtual-accounts')
  @ApiOperation({ summary: 'Listar Virtual Accounts activas' })
  listVirtualAccounts(@CurrentUser() user: AuthenticatedUser) {
    return this.bridgeService.listVirtualAccounts(user.id);
  }

  @Get('virtual-accounts/:id')
  @ApiOperation({
    summary: 'Detalle de Virtual Account con instrucciones bancarias',
  })
  getVirtualAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bridgeService.getVirtualAccount(id, user.id);
  }

  @Delete('virtual-accounts/:id')
  @ApiOperation({ summary: 'Desactivar Virtual Account' })
  deactivateVirtualAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bridgeService.deactivateVirtualAccount(id, user.id);
  }

  // ── External Accounts ─────────────────

  @Post('external-accounts')
  @ApiOperation({ summary: 'Registrar cuenta bancaria destino' })
  @ApiResponse({ status: 201, description: 'Cuenta registrada en Bridge' })
  createExternalAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateExternalAccountDto,
  ) {
    return this.bridgeService.createExternalAccount(user.id, dto);
  }

  @Get('external-accounts')
  @ApiOperation({ summary: 'Listar cuentas bancarias registradas' })
  listExternalAccounts(@CurrentUser() user: AuthenticatedUser) {
    return this.bridgeService.listExternalAccounts(user.id);
  }

  @Delete('external-accounts/:id')
  @ApiOperation({ summary: 'Desactivar cuenta bancaria' })
  deactivateExternalAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bridgeService.deactivateExternalAccount(id, user.id);
  }

  // ── Payouts ───────────────────────────

  @Post('payouts')
  @ApiOperation({
    summary: 'Crear solicitud de pago (con fee + reserva de saldo)',
  })
  @ApiResponse({ status: 201, description: 'Payout creado' })
  @ApiResponse({
    status: 400,
    description: 'Saldo insuficiente o límites excedidos',
  })
  createPayout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePayoutRequestDto,
  ) {
    return this.bridgeService.createPayout(user.id, dto);
  }

  @Get('payouts')
  @ApiOperation({ summary: 'Listar solicitudes de pago del usuario' })
  listPayouts(@CurrentUser() user: AuthenticatedUser) {
    return this.bridgeService.listPayoutRequests(user.id);
  }

  @Get('payouts/:id')
  @ApiOperation({ summary: 'Detalle de una solicitud de pago' })
  getPayoutDetail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bridgeService.getPayoutRequest(id, user.id);
  }

  // ── Transfers ─────────────────────────

  @Get('transfers')
  @ApiOperation({ summary: 'Historial de transferencias Bridge' })
  listTransfers(@CurrentUser() user: AuthenticatedUser) {
    return this.bridgeService.listTransfers(user.id);
  }

  @Get('transfers/:id')
  @ApiOperation({ summary: 'Detalle de transferencia' })
  getTransfer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bridgeService.getTransfer(id, user.id);
  }

  @Post('transfers/:id/sync')
  @ApiOperation({ summary: 'Sincronizar estado con Bridge API' })
  syncTransfer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.bridgeService.syncTransferFromBridge(id, user.id);
  }

  // ── Liquidation Addresses ─────────────

  @Post('liquidation-addresses')
  @ApiOperation({ summary: 'Crear dirección de liquidación crypto → fiat' })
  createLiquidationAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLiquidationAddressDto,
  ) {
    return this.bridgeService.createLiquidationAddress(user.id, dto);
  }

  @Get('liquidation-addresses')
  @ApiOperation({ summary: 'Listar direcciones de liquidación activas' })
  listLiquidationAddresses(@CurrentUser() user: AuthenticatedUser) {
    return this.bridgeService.listLiquidationAddresses(user.id);
  }
}

// ─────────────────────────────────────────────────
//  Admin: /admin/bridge/...
// ─────────────────────────────────────────────────

@ApiTags('Admin — Bridge')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/bridge')
@UseGuards(RolesGuard)
export class AdminBridgeController {
  constructor(private readonly bridgeService: BridgeService) {}

  // ── Transfers (bridge_transfers) ─────────

  @Get('transfers')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar todas las transferencias Bridge (admin)' })
  @ApiResponse({ status: 200, description: 'Lista paginada de bridge_transfers' })
  listAllTransfers(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('sourceRail') sourceRail?: string,
    @Query('destRail') destRail?: string,
    @CurrentUser() actor?: AuthenticatedUser,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const parsedOffset = offset ? parseInt(offset, 10) : undefined;
    return this.bridgeService.listAllTransfers({
      status,
      limit: parsedLimit != null && !isNaN(parsedLimit) ? parsedLimit : undefined,
      offset: parsedOffset != null && !isNaN(parsedOffset) ? parsedOffset : undefined,
      dateFrom,
      dateTo,
      sourceRail,
      destRail,
      callerRole: actor?.profile?.role,
    });
  }

  // ── Payouts (payout_requests) ────────────

  @Post('payouts/:id/approve')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Aprobar payout pendiente de revisión' })
  @ApiResponse({ status: 200, description: 'Payout aprobado y ejecutado' })
  approvePayout(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bridgeService.approvePayout(id, actor.id);
  }

  @Post('payouts/:id/reject')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Rechazar payout (libera saldo reservado)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  })
  rejectPayout(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { reason: string },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bridgeService.rejectPayout(id, body.reason, actor.id);
  }

  // ── VA Fee Defaults (globales) ─────────────────

  @Get('va-fee-defaults')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Listar fees globales por defecto (6 monedas × 2 destinos)',
  })
  listVaFeeDefaults() {
    return this.bridgeService.listVaFeeDefaults();
  }

  @Patch('va-fee-defaults')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Actualizar un fee global por defecto' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        source_currency: { type: 'string', example: 'usd' },
        destination_type: {
          type: 'string',
          example: 'wallet_bridge',
          enum: ['wallet_bridge', 'wallet_external'],
        },
        fee_percent: { type: 'number', example: 1.5 },
      },
      required: ['source_currency', 'destination_type', 'fee_percent'],
    },
  })
  updateVaFeeDefault(
    @Body()
    body: {
      source_currency: string;
      destination_type: string;
      fee_percent: number;
    },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bridgeService.updateVaFeeDefault(
      body.source_currency,
      body.destination_type,
      body.fee_percent,
      actor.id,
    );
  }

  // ── Liquidation Addresses (por usuario) ────────────

  @Get('users/:userId/liquidation-addresses')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar liquidation addresses de un usuario (admin)' })
  listUserLiquidationAddresses(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.bridgeService.listLiquidationAddressesByUserAdmin(userId);
  }

  @Patch('users/:userId/liquidation-addresses/:laId')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Actualizar liquidation address en Bridge y sincronizar DB (admin)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        external_account_id: { type: 'string' },
        custom_developer_fee_percent: { type: 'string', nullable: true },
        destination_ach_reference: { type: 'string' },
        destination_wire_message: { type: 'string' },
        destination_sepa_reference: { type: 'string' },
        destination_spei_reference: { type: 'string' },
        destination_reference: { type: 'string' },
        return_address: { type: 'string' },
      },
    },
  })
  updateUserLiquidationAddress(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('laId', new ParseUUIDPipe()) laId: string,
    @Body()
    body: {
      external_account_id?: string;
      custom_developer_fee_percent?: string | null;
      destination_ach_reference?: string;
      destination_wire_message?: string;
      destination_sepa_reference?: string;
      destination_spei_reference?: string;
      destination_reference?: string;
      return_address?: string;
    },
  ) {
    return this.bridgeService.updateLiquidationAddressAdmin(userId, laId, body);
  }

  // ── VA Fee Overrides (por usuario) ─────────────────

  @Get('users/:userId/va-fee-overrides')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar fee overrides de un usuario' })
  listVaFeeOverrides(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.bridgeService.listVaFeeOverrides(userId);
  }

  @Patch('users/:userId/va-fee-overrides')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Establecer/actualizar un fee override para un usuario',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        source_currency: { type: 'string', example: 'usd' },
        destination_type: {
          type: 'string',
          example: 'wallet_bridge',
          enum: ['wallet_bridge', 'wallet_external'],
        },
        fee_percent: { type: 'number', example: 0.5 },
        reason: {
          type: 'string',
          example: 'Tarifa preferencial para cliente VIP',
        },
      },
      required: [
        'source_currency',
        'destination_type',
        'fee_percent',
        'reason',
      ],
    },
  })
  setVaFeeOverride(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body()
    body: {
      source_currency: string;
      destination_type: string;
      fee_percent: number;
      reason: string;
    },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bridgeService.setVaFeeOverride(userId, body, actor.id);
  }

  @Delete('users/:userId/va-fee-overrides')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Eliminar un fee override de un usuario' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        source_currency: { type: 'string', example: 'usd' },
        destination_type: {
          type: 'string',
          example: 'wallet_bridge',
          enum: ['wallet_bridge', 'wallet_external'],
        },
      },
      required: ['source_currency', 'destination_type'],
    },
  })
  clearVaFeeOverride(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: { source_currency: string; destination_type: string },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bridgeService.clearVaFeeOverride(
      userId,
      body.source_currency,
      body.destination_type,
      actor.id,
    );
  }

  // ── VA Fee Matrix (resuelto) ─────────────────

  @Get('users/:userId/va-fee-matrix')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Obtener matriz de fees resueltos (12 combinaciones) con fuente',
  })
  getVaFeeMatrix(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.bridgeService.getResolvedVaFeeMatrix(userId);
  }

  // ── VAs de usuario (admin) ─────────────────

  @Get('users/:userId/virtual-accounts')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'List active VAs for a user (admin)' })
  listUserVirtualAccounts(
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.bridgeService.listUserVirtualAccounts(userId);
  }

  // ── Actualizar VA (fee, destination_address, destination_currency) ──────────

  @Patch('virtual-accounts/:id')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Actualizar VA existente (fee, destino, moneda) via PUT a Bridge',
  })
  updateVirtualAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateVirtualAccountDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bridgeService.updateVirtualAccount(id, dto, actor.id);
  }
}

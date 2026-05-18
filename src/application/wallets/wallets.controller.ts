import {
  Controller,
  Get,
  Post,
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
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { WalletsService } from './wallets.service';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import { ManualAdjustmentDto } from './dto/manual-adjustment.dto';

// ─────────────────────────────────────────────────
//  Rutas de usuario: /wallets/...
// ─────────────────────────────────────────────────

@ApiTags('Wallets')
@ApiBearerAuth('supabase-jwt')
@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar wallets activas del usuario' })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.walletsService.findAllByUser(user.id);
  }

  @Get('balances')
  @ApiOperation({ summary: 'Balances del usuario (todas las monedas)' })
  getBalances(@CurrentUser() user: AuthenticatedUser) {
    return this.walletsService.getBalances(user.id);
  }

  @Get('balances/:currency')
  @ApiOperation({ summary: 'Balance de una divisa específica' })
  getBalanceByCurrency(
    @CurrentUser() user: AuthenticatedUser,
    @Param('currency') currency: string,
  ) {
    return this.walletsService.getBalanceByCurrency(user.id, currency);
  }

  @Get('payin-routes')
  @ApiOperation({ summary: 'Rutas de pago disponibles (cuentas virtuales)' })
  getPayinRoutes(@CurrentUser() user: AuthenticatedUser) {
    return this.walletsService.getPayinRoutes(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una wallet específica' })
  findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.walletsService.findOne(id, user.id);
  }
}

@ApiTags('Admin — Wallets')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/wallets')
@UseGuards(RolesGuard)
export class AdminWalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post('balances/adjust')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Ajuste manual de balance (con audit log)' })
  @ApiResponse({ status: 200, description: 'Balance ajustado' })
  @ApiResponse({ status: 400, description: 'Saldo negativo resultante' })
  adjustBalance(
    @Body() dto: ManualAdjustmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.walletsService.adjustBalance(
      dto.user_id,
      dto.currency,
      dto.amount,
      dto.reason,
      actor.id,
    );
  }

  @Post('initialize/:userId')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Re-inicializar wallets de un usuario aprobado',
    description:
      'Útil cuando el webhook de aprobación KYC/KYB falló y las wallets en Bridge no se crearon. ' +
      'Requiere que el usuario tenga bridge_customer_id en su perfil.',
  })
  @ApiResponse({
    status: 200,
    description: 'Wallets inicializadas correctamente',
  })
  @ApiResponse({
    status: 404,
    description: 'Usuario o bridge_customer_id no encontrado',
  })
  initializeWallets(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.walletsService.initializeClientWallets(userId);
  }
}

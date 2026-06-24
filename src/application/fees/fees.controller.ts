import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { FeesService } from './fees.service';
import {
  CreateFeeDto,
  UpdateFeeDto,
  CreateFeeOverrideDto,
} from './dto/create-fee.dto';
import { UpdateFeeOverrideDto } from './dto/update-fee-override.dto';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

// ─────────────────────────────────────────────────
//  Ruta pública: /fees
// ─────────────────────────────────────────────────

@ApiTags('Fees')
@ApiBearerAuth('supabase-jwt')
@Controller('fees')
export class FeesController {
  constructor(private readonly feesService: FeesService) {}

  @Get()
  @ApiOperation({ summary: 'Listar tarifas vigentes' })
  @ApiResponse({ status: 200, description: 'Tarifas activas' })
  getPublicFees() {
    return this.feesService.getPublicFees();
  }

  @Get('preview')
  @ApiOperation({
    summary: 'Previsualizar fee para el usuario autenticado',
    description:
      'Devuelve el fee que se aplicaría a la operación, considerando overrides personales. No crea ningún registro.',
  })
  @ApiResponse({ status: 200, description: 'Estimación de fee' })
  previewFee(
    @CurrentUser() user: AuthenticatedUser,
    @Query('operation_type') operationType: string,
    @Query('payment_rail') paymentRail: string,
    @Query('currency') currency: string,
    @Query('amount') amountRaw: string,
  ) {
    if (!operationType || !paymentRail || !currency || !amountRaw) {
      throw new BadRequestException(
        'Se requieren los parámetros operation_type, payment_rail, currency y amount.',
      );
    }
    const amount = parseFloat(amountRaw);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('El parámetro amount debe ser un número positivo.');
    }
    return this.feesService.previewFee(user.id, operationType, paymentRail, currency, amount);
  }
}

// ─────────────────────────────────────────────────
//  Rutas admin: /admin/fees/...
// ─────────────────────────────────────────────────

@ApiTags('Admin — Fees')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/fees')
@UseGuards(RolesGuard)
export class AdminFeesController {
  constructor(private readonly feesService: FeesService) {}

  @Get()
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar todas las tarifas (activas e inactivas)' })
  getAllFees() {
    return this.feesService.getAllFees();
  }

  @Post()
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Crear nueva tarifa' })
  @ApiResponse({ status: 201, description: 'Tarifa creada' })
  createFee(@Body() dto: CreateFeeDto) {
    return this.feesService.createFee(dto);
  }

  @Patch(':id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Actualizar tarifa' })
  updateFee(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateFeeDto,
  ) {
    return this.feesService.updateFee(id, dto);
  }

  @Delete(':id')
  @Roles('super_admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar tarifa global permanentemente' })
  @ApiResponse({ status: 200, description: 'Tarifa eliminada' })
  deleteFee(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.feesService.deleteFee(id, actor.id, actor.profile.role);
  }

  @Get('overrides/:userId')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Overrides de fee para un usuario' })
  getOverrides(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.feesService.getOverrides(userId);
  }

  @Post('overrides')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Crear override de fee para cliente VIP' })
  @ApiResponse({ status: 201, description: 'Override creado' })
  createOverride(
    @Body() dto: CreateFeeOverrideDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.feesService.createOverride(dto, actor.id, actor.profile.role);
  }

  @Patch('overrides/:id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Actualizar override de fee' })
  @ApiResponse({ status: 200, description: 'Override actualizado' })
  updateOverride(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateFeeOverrideDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.feesService.updateOverride(id, dto, actor.id, actor.profile.role);
  }

  @Delete('overrides/:id')
  @Roles('super_admin')
  @ApiOperation({ summary: 'Eliminar override de fee permanentemente' })
  @ApiResponse({ status: 200, description: 'Override eliminado' })
  deleteOverride(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.feesService.deleteOverride(id, actor.id, actor.profile.role);
  }
}

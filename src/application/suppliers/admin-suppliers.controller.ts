import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SuppliersService } from './suppliers.service';
import { SetSupplierComplianceDto } from './dto/supplier-compliance.dto';
import { DiditWalletRescreeningService } from '../didit/didit-wallet-rescreening.service';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';

/**
 * Cola de cumplimiento de beneficiarios.
 *
 * Sin estos endpoints el estado `pending_review` sería decorativo: el
 * re-screening marcaría beneficiarios que nadie podría resolver.
 */
@ApiTags('Admin — Beneficiarios (Compliance)')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/suppliers')
@UseGuards(RolesGuard)
export class AdminSuppliersController {
  constructor(
    private readonly suppliersService: SuppliersService,
    private readonly rescreening: DiditWalletRescreeningService,
  ) {}

  @Get('compliance')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Beneficiarios bloqueados o pendientes de revisión de compliance',
  })
  @ApiResponse({ status: 200, description: 'Listado con el veredicto de screening' })
  listFlagged() {
    return this.suppliersService.listComplianceFlagged();
  }

  @Patch(':id/compliance')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Bloquear o liberar un beneficiario por cumplimiento',
    description:
      'Bloquear desactiva además su liquidation address en Bridge y notifica al cliente. ' +
      'Liberar reactiva la liquidation address y también notifica al cliente.',
  })
  @ApiResponse({ status: 200, description: 'Estado de cumplimiento actualizado' })
  @ApiResponse({ status: 404, description: 'Beneficiario no encontrado' })
  setCompliance(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetSupplierComplianceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.suppliersService.setComplianceStatus(id, dto, {
      id: actor.id,
      role: actor.profile.role,
    });
  }

  @Post(':id/rescreen')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Forzar el re-screening AML de la dirección de un beneficiario',
    description:
      'Ignora el intervalo configurado. Cada llamada consume una revisión facturable en Didit.',
  })
  @ApiResponse({ status: 201, description: 'Veredicto y estado resultante' })
  @ApiResponse({ status: 404, description: 'Beneficiario cripto no encontrado' })
  rescreen(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.rescreening.rescreenById(id);
  }
}

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
  Res,
  StreamableFile,
  BadRequestException,
  NotFoundException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { IdempotencyInterceptor } from '../../core/interceptors/idempotency.interceptor';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { Roles } from '../../core/decorators/roles.decorator';
import { RolesGuard } from '../../core/guards/roles.guard';
import {
  Public,
  type AuthenticatedUser,
} from '../../core/guards/supabase-auth.guard';
import { PaymentOrdersService } from './payment-orders.service';
import { OrderReviewService } from './order-review.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { PsavService } from '../psav/psav.service';
import { PdfService } from '../../core/pdf/pdf.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { ExportService } from '../../core/export/export.service';
import { ProfilesService } from '../profiles/profiles.service';
import { WalletsService } from '../wallets/wallets.service';
import { ClientBankAccountsService } from '../client-bank-accounts/client-bank-accounts.service';
import { CreateInterbankOrderDto } from './dto/create-interbank-order.dto';
import { CreateWalletRampOrderDto } from './dto/create-wallet-ramp-order.dto';
import { ConfirmDepositDto } from './dto/confirm-deposit.dto';
import {
  ApproveOrderDto,
  MarkSentDto,
  CompleteOrderDto,
  FailOrderDto,
} from './dto/admin-order-action.dto';
import { UpsertPsavAccountDto } from './dto/upsert-psav-account.dto';
import {
  BRIDGE_RAMP_ON_ROUTES,
  BRIDGE_RAMP_OFF_ROUTES,
  FIAT_BO_OFF_RAMP_ROUTES,
  FIAT_BO_ALLOWED_DESTINATION_CURRENCIES,
  FIAT_BO_EXCLUDED_SOURCE_CURRENCIES,
} from '../../common/constants/bridge-route-catalog.constants';
import { getValidSourceRoutes } from '../../common/constants/transfer-route-catalog.constants';
import {
  GOVERNED_FLOWS,
  isGovernedFlow,
} from '../../common/constants/flow-access.constants';

// ═══════════════════════════════════════════════
//  USER CONTROLLER — /payment-orders
// ═══════════════════════════════════════════════

@ApiTags('Payment Orders')
@ApiBearerAuth('supabase-jwt')
@Controller('payment-orders')
export class PaymentOrdersController {
  constructor(
    private readonly paymentOrdersService: PaymentOrdersService,
    private readonly exchangeRatesService: ExchangeRatesService,
    private readonly psavService: PsavService,
    private readonly pdfService: PdfService,
    private readonly suppliersService: SuppliersService,
    private readonly exportService: ExportService,
    private readonly profilesService: ProfilesService,
    private readonly walletsService: WalletsService,
    private readonly orderReviewService: OrderReviewService,
    private readonly clientBankAccountsService: ClientBankAccountsService,
  ) {}

  // ── Crear órdenes ──

  @Post('interbank')
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Crear orden interbancaria (Bolivia ↔ Mundo)' })
  createInterbankOrder(
    @Body() dto: CreateInterbankOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const reviewContext = (dto as any).client_reason
      ? {
          clientReason: (dto as any).client_reason,
          documentUrl: dto.supporting_document_url,
        }
      : undefined;
    return this.paymentOrdersService.createInterbankOrder(
      user.id,
      dto,
      reviewContext,
    );
  }

  @Post('wallet-ramp')
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Crear orden de rampa on/off (Wallet Bridge)' })
  createWalletRampOrder(
    @Body() dto: CreateWalletRampOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const reviewContext = (dto as any).client_reason
      ? {
          clientReason: (dto as any).client_reason,
          documentUrl: dto.supporting_document_url,
        }
      : undefined;
    return this.paymentOrdersService.createWalletRampOrder(
      user.id,
      dto,
      reviewContext,
    );
  }

  // ── Consultas ──

  @Get()
  @ApiOperation({ summary: 'Listar mis órdenes de pago' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'flow_category', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'month', required: false, type: Number })
  getMyOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
    @Query('flow_category') flow_category?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('year') year?: string,
    @Query('month') month?: string,
  ) {
    return this.paymentOrdersService.getMyOrders(user.id, {
      status,
      flow_category,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      year: year ? parseInt(year, 10) : undefined,
      month: month ? parseInt(month, 10) : undefined,
    });
  }

  @Get('limits/:flow_type')
  @ApiOperation({
    summary:
      'Límites de monto (min/max USD) para un flow_type — incluye override personal si existe',
  })
  getPaymentLimits(
    @Param('flow_type') flow_type: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.getPaymentLimits(flow_type, user.id);
  }

  @Get('active-exclusive')
  @ApiOperation({
    summary: 'Verificar si el usuario tiene un expediente exclusivo activo',
  })
  getActiveExclusiveOrder(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentOrdersService.getActiveExclusiveOrder(user.id);
  }

  @Get('available-flows')
  @ApiOperation({
    summary:
      'Flujos de servicio visibles para el usuario (regla por país + override de staff)',
  })
  getAvailableFlows(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentOrdersService.getAvailableFlows(user.id);
  }

  @Get('route-catalog')
  @ApiOperation({
    summary: 'Catálogo de rutas Bridge soportadas (on-ramp y off-ramp)',
  })
  getRouteCatalog() {
    return {
      ramp_on: BRIDGE_RAMP_ON_ROUTES,
      ramp_off: BRIDGE_RAMP_OFF_ROUTES,
      fiat_bo_off_ramp: FIAT_BO_OFF_RAMP_ROUTES,
      fiat_bo_allowed_destinations: FIAT_BO_ALLOWED_DESTINATION_CURRENCIES,
      fiat_bo_excluded_sources: FIAT_BO_EXCLUDED_SOURCE_CURRENCIES,
    };
  }

  @Get('psav-configs')
  @ApiOperation({
    summary:
      'Cuentas PSAV crypto activas para resolución de rutas de retiro (sin campos sensibles)',
  })
  async getActivePsavCryptoConfigs() {
    const accounts = await this.psavService.getActiveCryptoAccounts();
    return accounts.map(
      ({ id, name, type, currency, crypto_network, is_active }) => ({
        id,
        name,
        type,
        currency,
        crypto_network,
        is_active,
      }),
    );
  }

  @Get('world-to-bolivia/available-sources')
  @ApiOperation({
    summary:
      'Divisas de origen disponibles para world_to_bolivia según canales PSAV activos del usuario',
  })
  getWorldToBoliviaAvailableSources(@CurrentUser() user: AuthenticatedUser) {
    return this.psavService.getAvailableWorldToBoliviaCurrencies(user.id);
  }

  @Get('exchange-rates')
  @ApiOperation({ summary: 'Obtener todos los tipos de cambio' })
  getExchangeRates() {
    return this.exchangeRatesService.getAllRates();
  }

  @Get('exchange-rates/:pair')
  @ApiOperation({
    summary: 'Obtener tipo de cambio para un par específico',
  })
  getExchangeRate(@Param('pair') pair: string) {
    return this.exchangeRatesService.getRate(pair);
  }

  @Get('export')
  @ApiOperation({
    summary:
      'Exportar historial de expedientes a Excel (respeta filtros activos)',
  })
  @ApiQuery({
    name: 'format',
    required: true,
    enum: ['excel'],
    description: 'Formato del archivo de exportación',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filtrar por estado (si se omite, exporta todos)',
  })
  @ApiQuery({
    name: 'year',
    required: false,
    type: Number,
    description: 'Gestión (año)',
  })
  @ApiQuery({
    name: 'month',
    required: false,
    type: Number,
    description: 'Mes (1-12)',
  })
  async exportOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query('format') format: string,
    @Query('status') status?: string,
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Res({ passthrough: true }) res?: any,
  ) {
    if (format !== 'excel') {
      throw new BadRequestException('El parámetro format debe ser "excel"');
    }

    const parsedYear = year ? parseInt(year, 10) : undefined;
    const parsedMonth = month ? parseInt(month, 10) : undefined;

    // Obtener órdenes filtradas (sin paginación)
    const orders = await this.paymentOrdersService.getOrdersForExport(user.id, {
      status,
      year: parsedYear,
      month: parsedMonth,
    });

    // Resolver nombres de proveedores
    const supplierIds = [
      ...new Set(orders.map((o: any) => o.supplier_id).filter(Boolean)),
    ];
    const suppliers = await this.suppliersService.findByIds(
      supplierIds as string[],
      user.id,
    );

    // Obtener perfil del cliente y teléfono
    const profile = await this.profilesService.findOne(user.id);
    const phone = await this.profilesService.getClientPhone(user.id);

    const client = {
      id: profile.id,
      full_name: profile.full_name ?? null,
      email: profile.email,
      phone,
    };

    const filters = { status, year: parsedYear, month: parsedMonth };
    const dateStr = new Date().toISOString().slice(0, 10);
    const buffer = await this.exportService.generateExcel(
      orders,
      suppliers,
      client,
      filters,
    );
    const contentType =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const filename = `expedientes-${dateStr}.xlsx`;

    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length,
    });

    return new StreamableFile(buffer);
  }

  @Get('transfer-routes/:supplierId')
  @ApiOperation({
    summary:
      'Rutas de origen válidas dado el destino crypto de un proveedor (wallet_to_wallet)',
  })
  async getTransferRoutes(
    @Param('supplierId', new ParseUUIDPipe()) supplierId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const supplier = await this.suppliersService.findOne(supplierId, user.id);
    const destNetwork = supplier?.bank_details?.wallet_network as
      | string
      | undefined;
    const destCurrency = supplier?.bank_details?.wallet_currency as
      | string
      | undefined;

    if (!destNetwork || !destCurrency) {
      return {
        dest_network: null,
        dest_currency: null,
        sources: [],
        message:
          'El proveedor no tiene red/moneda crypto configurada en bank_details.',
      };
    }

    const sources = getValidSourceRoutes(destNetwork, destCurrency);
    return {
      dest_network: destNetwork.toLowerCase(),
      dest_currency: destCurrency.toLowerCase(),
      sources,
    };
  }

  @Get('my-flow-stats')
  @ApiOperation({
    summary:
      'Flujos interbank del usuario agrupados por moneda (mapa del dashboard)',
  })
  @ApiQuery({ name: 'month', required: false })
  getMyFlowStats(
    @CurrentUser() user: AuthenticatedUser,
    @Query('month') month?: string,
  ) {
    return this.paymentOrdersService.getMyFlowStats(user.id, month);
  }

  @Get('my-flow-months')
  @ApiOperation({
    summary: 'Meses con transacciones interbank completadas del usuario',
  })
  getMyFlowMonths(@CurrentUser() user: AuthenticatedUser) {
    return this.paymentOrdersService.getMyFlowMonths(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una orden' })
  getOrderById(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.getOrderById(user.id, id);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Generar comprobante operativo en PDF de la orden' })
  async getOrderPdf(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: any,
  ) {
    const order = await this.paymentOrdersService.getOrderById(user.id, id);
    let supplier = null;
    if (order.supplier_id) {
      try {
        supplier = await this.suppliersService.findOne(
          order.supplier_id,
          user.id,
        );
      } catch (e) {
        // Ignorar si no se encuentra
      }
    }

    const profile = await this.profilesService.findOne(order.user_id);
    const [phone, identity] = await Promise.all([
      this.profilesService.getClientPhone(order.user_id),
      this.profilesService.getClientIdentityForPdf(order.user_id),
    ]);
    const client = {
      id: profile.id,
      full_name: profile.full_name ?? null,
      email: profile.email,
      phone,
      identity_label: identity?.identity_label ?? null,
      identity_value: identity?.identity_value ?? null,
      country: identity?.country ?? null,
      is_company: identity?.is_company ?? false,
    };

    let clientWallet = null;
    if (order.wallet_id) {
      try {
        clientWallet = await this.walletsService.findOne(
          order.wallet_id,
          order.user_id,
        );
      } catch (e) {
        // Ignorar si no se encuentra
      }
    }

    // Cuenta bancaria BOB del cliente — para flujos de retiro a Bolivia y world_to_bolivia
    const needsBankAccount = ['bridge_wallet_to_fiat_bo', 'world_to_bolivia'].includes(order.flow_type);
    const clientBankAccount = needsBankAccount
      ? await this.clientBankAccountsService.findPrimary(order.user_id)
      : null;

    const buffer = await this.pdfService.generatePaymentPdf(
      order,
      supplier,
      client,
      clientWallet,
      clientBankAccount,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="payment-order-${id.slice(0, 8)}.pdf"`,
      'Content-Length': buffer.length,
    });

    return new StreamableFile(buffer);
  }

  // ── Acciones del usuario ──

  @Patch(':id')
  @ApiOperation({
    summary:
      'Actualizar campos editables de una orden (supporting_document_url, notes)',
  })
  updateOrder(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.updateOrderByUser(user.id, id, dto);
  }

  @Post(':id/confirm-deposit')
  @ApiOperation({
    summary: 'Confirmar depósito con comprobante (usuario)',
  })
  confirmDeposit(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConfirmDepositDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.confirmDeposit(user.id, id, dto);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancelar una orden pendiente' })
  cancelOrder(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.cancelOrder(user.id, id);
  }

  // ── Solicitudes de revisión por exceso de límite (cliente) ──

  @Get('review-requests')
  @ApiOperation({
    summary: 'Listar mis solicitudes de revisión por exceso de límite',
  })
  getMyReviews(@CurrentUser() user: AuthenticatedUser) {
    return this.orderReviewService.getMyReviews(user.id);
  }

  @Get('review-requests/:id')
  @ApiOperation({ summary: 'Detalle de una solicitud de revisión propia' })
  getMyReview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orderReviewService.getMyReview(user.id, id);
  }

  @Delete('review-requests/:id')
  @ApiOperation({ summary: 'Cancelar una solicitud de revisión pendiente' })
  cancelReview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orderReviewService.cancelReview(user.id, id);
  }
}

// ═══════════════════════════════════════════════
//  ADMIN CONTROLLER — /admin/payment-orders
// ═══════════════════════════════════════════════

@ApiTags('Admin - Payment Orders')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/payment-orders')
@UseGuards(RolesGuard)
export class AdminPaymentOrdersController {
  constructor(
    private readonly paymentOrdersService: PaymentOrdersService,
    private readonly exchangeRatesService: ExchangeRatesService,
    private readonly psavService: PsavService,
    private readonly orderReviewService: OrderReviewService,
  ) {}

  // ── Listados ──

  @Get()
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar todas las órdenes (admin)' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'flow_type', required: false })
  @ApiQuery({ name: 'flow_category', required: false })
  @ApiQuery({ name: 'requires_psav', required: false, type: Boolean })
  @ApiQuery({ name: 'user_id', required: false })
  @ApiQuery({ name: 'from_date', required: false })
  @ApiQuery({ name: 'to_date', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listAllOrders(
    @Query('status') status?: string,
    @Query('flow_type') flow_type?: string,
    @Query('flow_category') flow_category?: string,
    @Query('requires_psav') requires_psav?: string,
    @Query('user_id') user_id?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.paymentOrdersService.listAllOrders({
      status,
      flow_type,
      flow_category,
      requires_psav:
        requires_psav !== undefined ? requires_psav === 'true' : undefined,
      user_id,
      from_date,
      to_date,
      q,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('stats')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Estadísticas del dashboard de órdenes' })
  getStats() {
    return this.paymentOrdersService.getOrderStats();
  }

  @Get('global-flow-stats')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Flujos globales interbank agrupados por mes (mapa)',
  })
  getGlobalFlowStats(@Query('month') month?: string) {
    return this.paymentOrdersService.getGlobalFlowStats(month);
  }

  @Get('global-flow-months')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Meses disponibles con transacciones interbank' })
  getGlobalFlowMonths() {
    return this.paymentOrdersService.getGlobalFlowMonths();
  }

  // ── Acciones de estado ──

  @Post(':id/generate-psav-receipt')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Generar PDF de evidencia PSAV y guardarlo en receipt_url (bolivia_to_world)' })
  generatePsavReceipt(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.generatePsavReceipt(id, user.id);
  }

  @Post(':id/approve')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Aprobar orden (deposit_received → processing)' })
  approveOrder(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApproveOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.approveOrder(id, user.id, dto);
  }

  @Post(':id/mark-sent')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Marcar como enviada (processing → sent)' })
  markSent(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MarkSentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.markSent(id, user.id, dto);
  }

  @Post(':id/complete')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Completar orden (sent → completed)' })
  completeOrder(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CompleteOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.completeOrder(id, user.id, dto);
  }

  @Post(':id/fail')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Fallar una orden (cualquier estado → failed)' })
  failOrder(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: FailOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.failOrder(id, user.id, dto);
  }

  // ── PSAV Agents Admin ──

  @Get('psavs')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar agentes PSAV con sus canales y conteo de clientes' })
  listPsavs() {
    return this.psavService.listPsavs();
  }

  @Post('psavs')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Crear agente PSAV' })
  createPsav(@Body() dto: { name: string; verification_code?: string }) {
    if (!dto.name) {
      throw new BadRequestException('name es requerido');
    }
    return this.psavService.createPsav(dto as any);
  }

  @Patch('psavs/:id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Actualizar agente PSAV (nombre, código, is_active)' })
  updatePsav(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.psavService.updatePsav(id, dto as any);
  }

  @Delete('psavs/:id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Desactivar agente PSAV' })
  deactivatePsav(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.psavService.deactivatePsav(id);
  }

  @Get('psavs/:id/clients')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar clientes asignados a un agente PSAV' })
  listPsavClients(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.psavService.listAssignedClients(id);
  }

  // ── Asignación manual de PSAV a usuario ──

  @Post('psavs/assign-user')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Asignar (o reasignar) un PSAV específico a un usuario' })
  assignPsavToUser(
    @Body() dto: { user_id: string; psav_id: string },
  ) {
    if (!dto.user_id || !dto.psav_id) {
      throw new BadRequestException('user_id y psav_id son requeridos');
    }
    return this.psavService.assignPsavToUser(dto.user_id, dto.psav_id);
  }

  // ── PSAV Accounts Admin (canales) ──

  @Get('psav-accounts')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar canales PSAV (opcionalmente filtrar por psav_id)' })
  listPsavAccounts(@Query('psav_id') psavId?: string) {
    return this.psavService.listAccounts(psavId);
  }

  @Post('psav-accounts')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Crear canal PSAV (requiere psav_id)' })
  upsertPsavAccount(@Body() dto: UpsertPsavAccountDto) {
    if (dto.id) {
      const { id, ...rest } = dto;
      return this.psavService.updateAccount(id, rest);
    }
    if (!dto.psav_id || !dto.name || !dto.type || !dto.currency) {
      throw new BadRequestException(
        'psav_id, name, type y currency son requeridos para crear un canal PSAV',
      );
    }
    return this.psavService.createAccount({
      psav_id: dto.psav_id,
      name: dto.name,
      type: dto.type,
      currency: dto.currency,
      bank_name: dto.bank_name,
      account_number: dto.account_number,
      routing_number: dto.routing_number,
      account_holder: dto.account_holder,
      qr_url: dto.qr_url,
      crypto_address: dto.crypto_address,
      crypto_network: dto.crypto_network,
    });
  }

  @Patch('psav-accounts/:id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Actualizar canal PSAV' })
  updatePsavAccount(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.psavService.updateAccount(id, dto as any);
  }

  @Delete('psav-accounts/:id')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Eliminar canal PSAV' })
  deletePsavAccount(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.psavService.deleteAccount(id);
  }

  // ── Limits Admin ──

  @Get('limits')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar todos los límites de monto por servicio' })
  getAllLimits() {
    return this.paymentOrdersService.getAllPaymentLimits();
  }

  @Patch('limits/:key')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Actualizar un límite de monto por servicio (MIN_* o MAX_*_USD)',
  })
  updateLimit(@Param('key') key: string, @Body() dto: { value: number }) {
    const ALLOWED_LIMIT_KEYS = new Set([
      'MIN_BOLIVIA_TO_WORLD_USD',
      'MAX_BOLIVIA_TO_WORLD_USD',
      'MIN_BOLIVIA_TO_WALLET_USD',
      'MAX_BOLIVIA_TO_WALLET_USD',
      'MIN_WALLET_TO_WALLET_USD',
      'MAX_WALLET_TO_WALLET_USD',
      'MIN_WORLD_TO_BOLIVIA_USD',
      'MAX_WORLD_TO_BOLIVIA_USD',
      'MIN_FIAT_BO_TO_BRIDGE_WALLET_USD',
      'MAX_FIAT_BO_TO_BRIDGE_WALLET_USD',
      'MIN_CRYPTO_TO_BRIDGE_WALLET_USD',
      'MAX_CRYPTO_TO_BRIDGE_WALLET_USD',
      'MIN_BRIDGE_WALLET_TO_FIAT_BO_USD',
      'MAX_BRIDGE_WALLET_TO_FIAT_BO_USD',
      'MIN_BRIDGE_WALLET_TO_FIAT_US_USD',
      'MAX_BRIDGE_WALLET_TO_FIAT_US_USD',
      'MIN_BRIDGE_WALLET_TO_CRYPTO_USD',
      'MAX_BRIDGE_WALLET_TO_CRYPTO_USD',
    ]);
    if (!ALLOWED_LIMIT_KEYS.has(key)) {
      throw new BadRequestException(`Clave de límite no permitida: ${key}`);
    }
    if (typeof dto.value !== 'number' || dto.value < 0) {
      throw new BadRequestException('value debe ser un número >= 0');
    }
    return this.paymentOrdersService.updatePaymentLimit(key, dto.value);
  }

  // ── Limit Overrides por cliente ──

  @Get('limit-overrides/:userId')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar overrides de límite de un cliente VIP' })
  getLimitOverrides(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.paymentOrdersService.getLimitOverrides(userId);
  }

  @Post('limit-overrides')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Crear override de límite para un cliente VIP' })
  createLimitOverride(
    @Body()
    dto: {
      user_id: string;
      flow_type: string;
      min_usd?: number | null;
      max_usd?: number | null;
      valid_from?: string;
      valid_until?: string;
      notes?: string;
    },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!dto.user_id || !dto.flow_type) {
      throw new BadRequestException('user_id y flow_type son requeridos');
    }
    return this.paymentOrdersService.createLimitOverride(dto, actor.id);
  }

  @Patch('limit-overrides/:id')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary:
      'Actualizar override de límite (valores, is_active, valid_until, notes)',
  })
  updateLimitOverride(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body()
    dto: {
      min_usd?: number | null;
      max_usd?: number | null;
      is_active?: boolean;
      valid_until?: string;
      notes?: string;
    },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.updateLimitOverride(id, dto, actor.id);
  }

  @Delete('limit-overrides/:id')
  @Roles('super_admin')
  @ApiOperation({
    summary: 'Eliminar override de límite permanentemente (solo super_admin)',
  })
  deleteLimitOverride(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.deleteLimitOverride(id, actor.id);
  }

  // ── Flow Overrides por cliente (visibilidad de flujos) ──

  @Get('flow-overrides/:userId')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary:
      'Visibilidad de flujos de un cliente: default por país, override y efectivo + filas de override',
  })
  async getFlowOverrides(@Param('userId', new ParseUUIDPipe()) userId: string) {
    const [summary, overrides] = await Promise.all([
      this.paymentOrdersService.getAvailableFlows(userId),
      this.paymentOrdersService.getFlowOverrides(userId),
    ]);
    return { ...summary, governed_flows: GOVERNED_FLOWS, overrides };
  }

  @Post('flow-overrides')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Forzar visibilidad (on/off) de un flujo para un cliente',
  })
  createFlowOverride(
    @Body()
    dto: {
      user_id: string;
      flow_type: string;
      is_enabled: boolean;
      notes?: string;
    },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!dto.user_id || !dto.flow_type) {
      throw new BadRequestException('user_id y flow_type son requeridos');
    }
    if (typeof dto.is_enabled !== 'boolean') {
      throw new BadRequestException('is_enabled debe ser booleano');
    }
    if (!isGovernedFlow(dto.flow_type)) {
      throw new BadRequestException(`flow_type no gobernado: ${dto.flow_type}`);
    }
    return this.paymentOrdersService.createFlowOverride(dto, actor.id);
  }

  @Patch('flow-overrides/:id')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Actualizar override de flujo (is_enabled, is_active, notes)',
  })
  updateFlowOverride(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: { is_enabled?: boolean; is_active?: boolean; notes?: string },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.updateFlowOverride(id, dto, actor.id);
  }

  @Delete('flow-overrides/:id')
  @Roles('super_admin')
  @ApiOperation({
    summary: 'Eliminar override de flujo permanentemente (solo super_admin)',
  })
  deleteFlowOverride(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.deleteFlowOverride(id, actor.id);
  }

  // ── Exchange Rates Admin ──

  @Get('exchange-rates')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Listar tipos de cambio (admin)' })
  getAllRates() {
    return this.exchangeRatesService.getAllRates();
  }

  @Post('exchange-rates/sync')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Sincronizar tipos de cambio manualmente desde el mercado P2P',
  })
  syncExternalRates(@CurrentUser() user: AuthenticatedUser) {
    return this.exchangeRatesService.syncExternalRates(user.id);
  }

  @Post('exchange-rates/:pair')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Actualizar tipo de cambio' })
  updateRate(
    @Param('pair') pair: string,
    @Body() dto: { rate: number; spread_percent?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.exchangeRatesService.updateRate(pair, dto, user.id);
  }

  // ── Revisiones por exceso de límite (admin) ──

  @Get('order-reviews')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Listar solicitudes de revisión por exceso de límite',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'flow_type', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  listOrderReviews(
    @Query('status') status?: string,
    @Query('flow_type') flow_type?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedPage = page ? parseInt(page, 10) : undefined;
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    return this.orderReviewService.listReviews({
      status,
      flow_type,
      page: parsedPage && !isNaN(parsedPage) ? parsedPage : undefined,
      limit: parsedLimit && !isNaN(parsedLimit) ? parsedLimit : undefined,
    });
  }

  @Get('order-reviews/:id')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Detalle de una solicitud de revisión' })
  getOrderReview(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.orderReviewService.getReviewById(id);
  }

  @Post('order-reviews/:id/approve')
  @Roles('admin', 'super_admin')
  @ApiOperation({
    summary: 'Aprobar solicitud: crea el expediente y lo vincula',
  })
  approveOrderReview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: { staff_notes?: string },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.paymentOrdersService.createOrderFromReview(
      id,
      actor.id,
      dto.staff_notes,
    );
  }

  @Post('order-reviews/:id/reject')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Rechazar solicitud de revisión' })
  rejectOrderReview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: { staff_notes: string },
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!dto.staff_notes || dto.staff_notes.trim().length < 10) {
      throw new BadRequestException(
        'staff_notes es obligatorio (mínimo 10 caracteres)',
      );
    }
    return this.orderReviewService.rejectReview(id, actor.id, dto.staff_notes);
  }
}

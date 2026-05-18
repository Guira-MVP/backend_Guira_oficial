import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Patch,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import type { User } from '@supabase/supabase-js';
import { ComplianceService } from './compliance.service';
import { ComplianceActionsService } from './compliance-actions.service';
import {
  RegisterDocumentDto,
  GetDocumentUploadUrlDto,
} from './dto/document.dto';
import {
  ApproveReviewDto,
  RejectReviewDto,
  RequestChangesDto,
  AddCommentDto,
  AssignReviewDto,
  SetLimitsDto,
} from './dto/admin-compliance.dto';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

@ApiTags('Compliance')
@ApiBearerAuth('supabase-jwt')
@Controller('compliance')
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  // ── Documentos ────────────────────────────────────────────────────

  @Post('documents/upload-url')
  @ApiOperation({
    summary: 'Obtener URL firmada para subir documento a Storage',
  })
  getUploadUrl(
    @CurrentUser() user: User,
    @Body() dto: GetDocumentUploadUrlDto,
  ) {
    return this.complianceService.getDocumentUploadUrl(user.id, dto);
  }

  @Post('documents')
  @ApiOperation({ summary: 'Registrar documento tras subirlo a Storage' })
  registerDocument(
    @CurrentUser() user: User,
    @Body() dto: RegisterDocumentDto,
  ) {
    return this.complianceService.registerDocument(user.id, dto);
  }

  @Get('documents')
  @ApiOperation({ summary: 'Listar documentos del usuario' })
  @ApiQuery({ name: 'subject_type', required: false })
  listDocuments(
    @CurrentUser() user: User,
    @Query('subject_type') subjectType?: string,
  ) {
    return this.complianceService.listDocuments(user.id, subjectType);
  }

  // ── KYC (Lectura — crear/submit en /onboarding/kyc) ─────────────

  @Get('kyc')
  @ApiOperation({ summary: 'Obtener estado actual de KYC' })
  getKyc(@CurrentUser() user: User) {
    return this.complianceService.getKycApplication(user.id);
  }

  // ── KYB (Lectura — crear/submit en /onboarding/kyb) ─────────────

  @Get('kyb')
  @ApiOperation({ summary: 'Obtener estado actual de KYB (empresa)' })
  getKyb(@CurrentUser() user: User) {
    return this.complianceService.getKybApplication(user.id);
  }

  // ── Reviews ───────────────────────────────────────────────────────

  @Get('reviews')
  @ApiOperation({ summary: 'Historial de revisiones compliance' })
  getReviews(@CurrentUser() user: User) {
    return this.complianceService.getComplianceReviews(user.id);
  }
}

// ─────────────────────────────────────────────────
//  Admin: /admin/compliance/...
// ─────────────────────────────────────────────────

@ApiTags('Admin — Compliance')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/compliance')
@UseGuards(RolesGuard)
export class AdminComplianceController {
  constructor(private readonly actionsService: ComplianceActionsService) {}

  // ── REVIEWS (Lectura) ─────────────────────────────────────────────

  @Get('reviews')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Listar reviews pendientes / abiertos' })
  @ApiQuery({ name: 'priority', required: false })
  @ApiQuery({ name: 'assigned_to', required: false })
  listOpenReviews(
    @Query('priority') priority?: string,
    @Query('assigned_to') assignedTo?: string,
  ) {
    const filters: Record<string, string> = {};
    if (priority) filters.priority = priority;
    if (assignedTo) filters.assigned_to = assignedTo;
    return this.actionsService.listOpenReviews(filters);
  }

  @Get('reviews/:id')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Obtener detalle de review (comentarios e historial)',
  })
  getReviewDetail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.actionsService.getReviewDetail(id);
  }

  // ── REVIEWS (Acciones) ────────────────────────────────────────────

  @Patch('reviews/:id/assign')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Asignar review a un analista staff' })
  assignReview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignReviewDto,
    @CurrentUser() actor: User,
  ) {
    return this.actionsService.assignReview(id, dto.staff_user_id, actor.id);
  }

  @Patch('reviews/:id/escalate')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Escalar review a urgente' })
  escalateReview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() actor: User,
  ) {
    return this.actionsService.escalateReview(id, actor.id);
  }

  // ── COMMENTS ──────────────────────────────────────────────────────

  @Post('reviews/:id/comments')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Agregar comentario interno a un review' })
  addComment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddCommentDto,
    @CurrentUser() actor: User,
  ) {
    return this.actionsService.addComment(
      id,
      actor.id,
      dto.body,
      dto.is_internal,
    );
  }

  // ── DECISIONES (INMUTABLES) ───────────────────────────────────────

  @Post('reviews/:id/approve')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Enviar expediente a Bridge para verificación KYC/KYB',
    description:
      'Staff valida los datos y envía a Bridge. La aprobación final depende del webhook de Bridge.',
  })
  approveReview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ApproveReviewDto,
    @CurrentUser() actor: User,
  ) {
    return this.actionsService.approveReview(id, actor.id, dto.reason);
  }

  @Post('reviews/:id/reject')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Rechazar review (cancela operaciones/verificaciones)',
  })
  rejectReview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RejectReviewDto,
    @CurrentUser() actor: User,
  ) {
    return this.actionsService.rejectReview(id, actor.id, dto.reason);
  }

  @Post('reviews/:id/request-changes')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary: 'Solicitar correcciones al cliente (review permanece abierto)',
  })
  requestChanges(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RequestChangesDto,
    @CurrentUser() actor: User,
  ) {
    return this.actionsService.requestChanges(
      id,
      actor.id,
      dto.reason,
      dto.required_actions,
      dto.field_observations,
    );
  }
}

// ─────────────────────────────────────────────────
//  Admin: /admin/users/...
// ─────────────────────────────────────────────────

@ApiTags('Admin — Transaction Limits')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/users')
@UseGuards(RolesGuard)
export class AdminUserController {
  constructor(private readonly actionsService: ComplianceActionsService) {}

  @Post(':id/limits')
  @Roles('admin', 'super_admin')
  @ApiOperation({ summary: 'Establecer límites de transacción personalizados' })
  setTransactionLimits(
    @Param('id', new ParseUUIDPipe()) userId: string,
    @Body() dto: SetLimitsDto,
    @CurrentUser() actor: User,
  ) {
    return this.actionsService.setTransactionLimits(userId, actor.id, dto);
  }
}

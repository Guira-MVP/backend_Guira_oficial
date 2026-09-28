import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DOCUMENT_UPLOAD_LIMITS } from './document-file-validation';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { Roles } from '../../core/decorators/roles.decorator';
import { RolesGuard } from '../../core/guards/roles.guard';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';
import { SaveOnboardingDraftDto } from './dto/save-onboarding-draft.dto';
import { StaffOnboardingAssistService } from './staff-onboarding-assist.service';

/**
 * Onboarding asistido: el staff llena el formulario en nombre del cliente.
 *
 * Espejo de las rutas de borrador y documentos de /onboarding, pero con el
 * cliente en la URL. No hay rutas de envío ni de aceptación de términos: eso
 * lo hace siempre el propio cliente.
 */
@ApiTags('Admin — Onboarding asistido')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/onboarding-assist/users/:userId')
@UseGuards(RolesGuard)
@Roles('staff', 'admin', 'super_admin')
export class StaffOnboardingAssistController {
  constructor(private readonly assistService: StaffOnboardingAssistService) {}

  @Get()
  @ApiOperation({ summary: 'Datos del cliente y su borrador de onboarding' })
  getContext(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.assistService.getContext(userId);
  }

  @Put('draft')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Guardar el borrador en nombre del cliente' })
  @ApiResponse({ status: 409, description: 'La solicitud ya fue enviada' })
  saveDraft(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: SaveOnboardingDraftDto,
  ) {
    return this.assistService.saveDraft(actor, userId, dto);
  }

  @Post('documents/upload')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: DOCUMENT_UPLOAD_LIMITS }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Subir un documento al borrador del cliente' })
  uploadDocument(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: {
      document_type: string;
      subject_type: string;
      subject_id?: string;
      draft_key?: string;
    },
  ) {
    return this.assistService.uploadDocument(actor, userId, file, body);
  }

  @Delete('documents/:id')
  @ApiOperation({ summary: 'Quitar un documento del borrador del cliente' })
  deleteDocument(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.assistService.deleteDocument(actor, userId, id);
  }

  @Get('documents')
  @ApiOperation({ summary: 'Listar documentos activos del cliente' })
  listDocuments(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query('subject_type') subjectType?: string,
  ) {
    return this.assistService.listDocuments(userId, subjectType);
  }

  @Get('documents/:id/signed-url')
  @ApiOperation({ summary: 'URL firmada de un documento del cliente' })
  getDocumentSignedUrl(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.assistService.getDocumentSignedUrl(actor, userId, id);
  }

  @Post('ready')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Marcar la solicitud como lista y avisar al cliente para que la revise y envíe',
  })
  markReady(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    return this.assistService.markReady(actor, userId);
  }
}

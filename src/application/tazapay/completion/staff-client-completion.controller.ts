import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import { Roles } from '../../../core/decorators/roles.decorator';
import { RolesGuard } from '../../../core/guards/roles.guard';
import type { AuthenticatedUser } from '../../../core/guards/supabase-auth.guard';
import { DOCUMENT_UPLOAD_LIMITS } from '../../onboarding/document-file-validation';
import {
  CreateDirectorDto,
  CreateUboDto,
} from '../../onboarding/dto/create-director-ubo.dto';
import { StaffClientCompletionService } from './staff-client-completion.service';
import {
  StaffUpdateBusinessDto,
  StaffUpdateDirectorDto,
  StaffUpdatePersonDto,
  StaffUpdateUboDto,
} from './staff-client-completion.dto';

/**
 * Completar datos y documentos de un cliente ya aprobado (p. ej. migrado) para
 * poder enviarlo a Tazapay. No envía nada a Bridge ni a Tazapay: el envío es
 * providers/kyb|kyc/:id/send-to-tazapay.
 */
@ApiTags('Admin — Completar datos del cliente')
@ApiBearerAuth('supabase-jwt')
@Controller('admin/client-completion/users/:userId')
@UseGuards(RolesGuard)
@Roles('staff', 'admin', 'super_admin')
export class StaffClientCompletionController {
  constructor(private readonly completion: StaffClientCompletionService) {}

  @Get()
  @ApiOperation({
    summary: 'Datos actuales del cliente y qué falta para Tazapay',
  })
  getContext(@Param('userId', new ParseUUIDPipe()) userId: string) {
    return this.completion.getContext(userId);
  }

  @Put('person')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Guardar los datos personales del cliente' })
  savePerson(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: StaffUpdatePersonDto,
  ) {
    return this.completion.savePerson(actor, userId, dto);
  }

  @Put('business')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Guardar los datos de la empresa del cliente' })
  saveBusiness(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: StaffUpdateBusinessDto,
  ) {
    return this.completion.saveBusiness(actor, userId, dto);
  }

  @Post('directors')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Agregar un director / representante legal' })
  addDirector(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: CreateDirectorDto,
  ) {
    return this.completion.addDirector(actor, userId, dto);
  }

  @Patch('directors/:id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Editar un director / representante legal' })
  updateDirector(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: StaffUpdateDirectorDto,
  ) {
    return this.completion.updateDirector(actor, userId, id, dto);
  }

  @Delete('directors/:id')
  @ApiOperation({ summary: 'Quitar un director' })
  removeDirector(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.completion.removeDirector(actor, userId, id);
  }

  @Post('ubos')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Agregar un beneficiario final (UBO)' })
  addUbo(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: CreateUboDto,
  ) {
    return this.completion.addUbo(actor, userId, dto);
  }

  @Patch('ubos/:id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Editar un beneficiario final (UBO)' })
  updateUbo(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: StaffUpdateUboDto,
  ) {
    return this.completion.updateUbo(actor, userId, id, dto);
  }

  @Delete('ubos/:id')
  @ApiOperation({ summary: 'Quitar un beneficiario final (UBO)' })
  removeUbo(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.completion.removeUbo(actor, userId, id);
  }

  @Post('documents/upload')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: DOCUMENT_UPLOAD_LIMITS }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Subir un documento definitivo del cliente' })
  uploadDocument(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: {
      document_type: string;
      subject_type: string;
      subject_id?: string;
      document_subtype?: string;
    },
  ) {
    return this.completion.uploadDocument(actor, userId, file, body);
  }

  @Get('documents/:id/signed-url')
  @ApiOperation({ summary: 'URL firmada de un documento del cliente' })
  getDocumentSignedUrl(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.completion.getDocumentSignedUrl(actor, userId, id);
  }
}

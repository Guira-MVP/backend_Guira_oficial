import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UploadedFile,
  UseInterceptors,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { OnboardingService } from './onboarding.service';
import { CreatePersonDto } from './dto/create-person.dto';
import { CreateBusinessDto } from './dto/create-business.dto';
import { CreateDirectorDto, CreateUboDto } from './dto/create-director-ubo.dto';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../core/guards/supabase-auth.guard';

@ApiTags('Onboarding')
@ApiBearerAuth('supabase-jwt')
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  // ───────────────── KYC — Persona Natural ─────────────────

  @Post('kyc/person')
  @ApiOperation({ summary: 'Crear o actualizar datos biográficos (KYC)' })
  @ApiResponse({ status: 201, description: 'Datos de persona guardados' })
  upsertPerson(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePersonDto,
  ) {
    return this.onboardingService.upsertPerson(user.id, dto);
  }

  @Get('kyc/person')
  @ApiOperation({ summary: 'Obtener datos biográficos del usuario' })
  getPerson(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.getPerson(user.id);
  }

  @Post('kyc/application')
  @ApiOperation({ summary: 'Crear aplicación KYC' })
  @ApiResponse({ status: 201, description: 'Aplicación KYC creada' })
  createKycApplication(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.createKycApplication(user.id);
  }

  @Get('kyc/application')
  @ApiOperation({ summary: 'Estado de la aplicación KYC' })
  getKycApplication(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.getKycApplication(user.id);
  }

  @Get('kyc/tos-link')
  @ApiOperation({ summary: 'Obtener link para aceptar Terms of Service (KYC)' })
  @ApiResponse({ status: 200, description: 'URL de aceptación de ToS' })
  getKycTosLink(
    @CurrentUser() user: AuthenticatedUser,
    @Query('redirect_uri') redirectUri?: string,
  ) {
    return this.onboardingService.generateTosLink(user.id, redirectUri);
  }

  @Post('kyc/tos-accept')
  @ApiOperation({ summary: 'Aceptar Terms of Service (KYC)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tos_contract_id: {
          type: 'string',
          description: 'ID del contrato ToS de Bridge (opcional)',
        },
      },
    },
  })
  acceptKycTos(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { tos_contract_id?: string },
  ) {
    return this.onboardingService.acceptTos(user.id, body.tos_contract_id);
  }

  @Patch('kyc/application/submit')
  @ApiOperation({ summary: 'Enviar expediente KYC para revisión' })
  @ApiResponse({ status: 200, description: 'Expediente enviado' })
  @ApiResponse({ status: 400, description: 'Faltan documentos o ToS' })
  submitKycApplication(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.submitKycApplication(user.id);
  }

  // ───────────────── KYB — Empresa ─────────────────

  @Post('kyb/business')
  @ApiOperation({ summary: 'Crear o actualizar datos de la empresa' })
  upsertBusiness(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBusinessDto,
  ) {
    return this.onboardingService.upsertBusiness(user.id, dto);
  }

  @Get('kyb/business')
  @ApiOperation({
    summary: 'Obtener datos de la empresa con directores y UBOs',
  })
  getBusiness(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.getBusiness(user.id);
  }

  @Post('kyb/business/directors')
  @ApiOperation({ summary: 'Añadir director a la empresa' })
  addDirector(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDirectorDto,
  ) {
    return this.onboardingService.addDirector(user.id, dto);
  }

  @Delete('kyb/business/directors/:id')
  @ApiOperation({ summary: 'Eliminar director' })
  removeDirector(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.onboardingService.removeDirector(user.id, id);
  }

  @Post('kyb/business/ubos')
  @ApiOperation({ summary: 'Añadir beneficiario final (UBO) a la empresa' })
  addUbo(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUboDto) {
    return this.onboardingService.addUbo(user.id, dto);
  }

  @Delete('kyb/business/ubos/:id')
  @ApiOperation({ summary: 'Eliminar UBO' })
  removeUbo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.onboardingService.removeUbo(user.id, id);
  }

  @Post('kyb/application')
  @ApiOperation({ summary: 'Crear aplicación KYB' })
  createKybApplication(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.createKybApplication(user.id);
  }

  @Get('kyb/application')
  @ApiOperation({ summary: 'Estado de la aplicación KYB' })
  getKybApplication(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.getKybApplication(user.id);
  }

  @Get('kyb/tos-link')
  @ApiOperation({ summary: 'Obtener link para aceptar Terms of Service (KYB)' })
  @ApiResponse({ status: 200, description: 'URL de aceptación de ToS' })
  getKybTosLink(
    @CurrentUser() user: AuthenticatedUser,
    @Query('redirect_uri') redirectUri?: string,
  ) {
    return this.onboardingService.generateTosLink(user.id, redirectUri);
  }

  @Post('kyb/tos-accept')
  @ApiOperation({ summary: 'Aceptar Terms of Service (KYB)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tos_contract_id: { type: 'string' },
      },
    },
  })
  acceptKybTos(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { tos_contract_id?: string },
  ) {
    return this.onboardingService.acceptKybTos(user.id, body.tos_contract_id);
  }

  @Patch('kyb/application/submit')
  @ApiOperation({ summary: 'Enviar expediente KYB para revisión' })
  @ApiResponse({ status: 200, description: 'Expediente KYB enviado' })
  submitKybApplication(@CurrentUser() user: AuthenticatedUser) {
    return this.onboardingService.submitKybApplication(user.id);
  }

  // ───────────────── Documentos / Storage ─────────────────

  @Post('documents/upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Subir documento de identidad o empresa' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        document_type: {
          type: 'string',
          enum: [
            'passport',
            'drivers_license',
            'national_id',
            'proof_of_address',
            'incorporation_certificate',
            'tax_registration',
            'bank_statement',
            'other',
          ],
        },
        subject_type: {
          type: 'string',
          enum: ['person', 'business', 'director', 'ubo'],
        },
        subject_id: { type: 'string', format: 'uuid' },
      },
      required: ['file', 'document_type', 'subject_type'],
    },
  })
  @ApiResponse({ status: 201, description: 'Documento subido' })
  @ApiResponse({
    status: 400,
    description: 'Tipo de archivo no permitido o excede 10MB',
  })
  uploadDocument(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body()
    body: { document_type: string; subject_type: string; subject_id?: string },
  ) {
    return this.onboardingService.uploadDocument(
      user.id,
      file,
      body.document_type,
      body.subject_type,
      body.subject_id,
    );
  }

  @Get('documents')
  @ApiOperation({ summary: 'Listar documentos del usuario' })
  @ApiResponse({ status: 200, description: 'Lista de documentos' })
  listDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @Query('subject_type') subjectType?: string,
  ) {
    return this.onboardingService.listDocuments(user.id, subjectType);
  }

  @Get('documents/:id/signed-url')
  @ApiOperation({ summary: 'Obtener URL firmada para descargar un documento' })
  @ApiResponse({ status: 200, description: 'URL firmada (válida 1 hora)' })
  getDocumentSignedUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.onboardingService.getDocumentSignedUrl(user.id, id);
  }
}

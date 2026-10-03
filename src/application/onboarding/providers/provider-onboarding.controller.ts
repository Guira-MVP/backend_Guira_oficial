import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Inject } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../../core/supabase/supabase.module';
import type { AuthenticatedUser } from '../../../core/guards/supabase-auth.guard';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import { RolesGuard } from '../../../core/guards/roles.guard';
import { Roles } from '../../../core/decorators/roles.decorator';
import { ProviderOnboardingService } from './provider-onboarding.service';
import { TazapayKybOnboardingService } from '../../tazapay/onboarding/tazapay-kyb-onboarding.service';
import { TazapayKycOnboardingService } from '../../tazapay/onboarding/tazapay-kyc-onboarding.service';
import { TazapayMappingError } from '../../tazapay/onboarding/tazapay-business-mapper';

class ConfirmVerticalDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  vertical!: string;
}

class ShareholdingFlagDto {
  @IsBoolean()
  value!: boolean;
}

/**
 * Panel de staff: estado del cliente en cada proveedor (Bridge / Tazapay),
 * vertical de Tazapay del KYB y acciones de reenvío.
 */
@ApiTags('Admin - Proveedores')
@ApiBearerAuth('supabase-jwt')
@UseGuards(RolesGuard)
@Controller('admin/compliance/providers')
export class ProviderOnboardingController {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly providers: ProviderOnboardingService,
    private readonly tazapayKyb: TazapayKybOnboardingService,
    private readonly tazapayKyc: TazapayKycOnboardingService,
  ) {}

  @Get('users/:userId')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary:
      'Estado del cliente en Bridge y Tazapay, y evaluación de Tazapay del KYB',
  })
  async getUserProviders(@Param('userId', new ParseUUIDPipe()) userId: string) {
    const status = await this.providers.getProviderStatus(userId);
    const { data: business } = await this.supabase
      .from('businesses')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    let tazapay_kyb: Record<string, unknown> | null = null;
    if (business) {
      // Solo lectura: el vertical se guarda cuando el staff lo confirma.
      const evaluation = await this.tazapayKyb.evaluateBusiness(business);
      const { data: kyb } = await this.supabase
        .from('kyb_applications')
        .select('id')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      let missing: string[] = [];
      if (kyb?.id) {
        try {
          missing = this.tazapayKyb.missingForTazapay(
            await this.tazapayKyb.loadContext(kyb.id as string),
          );
        } catch {
          missing = [];
        }
      }
      tazapay_kyb = {
        business_id: business.id,
        kyb_application_id: kyb?.id ?? null,
        entity_type: business.entity_type,
        evaluation,
        // Confirmado por el staff; si no hay, el propuesto por la tabla.
        vertical: business.tazapay_vertical_confirmed_at
          ? business.tazapay_vertical
          : evaluation.vertical,
        vertical_quality: evaluation.quality,
        vertical_confirmed_at: business.tazapay_vertical_confirmed_at ?? null,
        shareholding_same_as_registration:
          business.shareholding_same_as_registration ?? false,
        ownership_in_incorporation_doc:
          business.ownership_in_incorporation_doc ?? false,
        missing_documents: missing,
      };
    }
    // KYC (persona): sin vertical; solo los faltantes de datos y documentos.
    let tazapay_kyc: Record<string, unknown> | null = null;
    if (!business) {
      const { data: kyc } = await this.supabase
        .from('kyc_applications')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (kyc?.id) {
        let missing: string[] = [];
        try {
          missing = this.tazapayKyc.missingForTazapay(
            await this.tazapayKyc.loadContext(kyc.id as string),
          );
        } catch (err) {
          missing = [(err as Error).message];
        }
        tazapay_kyc = { kyc_application_id: kyc.id, missing };
      }
    }
    return { ...status, tazapay_kyb, tazapay_kyc };
  }

  @Get('tazapay/verticals')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Catálogo de los 295 verticales de Tazapay' })
  listVerticals() {
    return this.tazapayKyb.listVerticals();
  }

  @Post('businesses/:businessId/tazapay-vertical')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Confirmar el vertical de Tazapay de una empresa' })
  async confirmVertical(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: ConfirmVerticalDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    try {
      const evaluation = await this.tazapayKyb.confirmVertical(
        businessId,
        dto.vertical,
        actor.id,
      );
      return { vertical: dto.vertical, evaluation };
    } catch (err) {
      if (err instanceof TazapayMappingError)
        throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Patch('businesses/:businessId/shareholding-same-as-registration')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary:
      'Marcar que la matrícula muestra a los socios con su % ("Same as Business Registration" de Tazapay)',
  })
  async setShareholdingFlag(
    @Param('businessId', new ParseUUIDPipe()) businessId: string,
    @Body() dto: ShareholdingFlagDto,
  ) {
    await this.tazapayKyb.setShareholdingSameAsRegistration(
      businessId,
      dto.value,
    );
    return { value: dto.value };
  }

  @Post('submissions/:submissionId/retry')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({ summary: 'Reintentar el envío a Tazapay' })
  retry(@Param('submissionId', new ParseUUIDPipe()) submissionId: string) {
    return this.providers.retryTazapay(submissionId);
  }

  @Post('kyc/:kycApplicationId/send-to-tazapay')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary:
      'Enviar a Tazapay un KYC ya aprobado en Bridge (envío pendiente o reenvío asistido)',
  })
  async sendKyc(
    @Param('kycApplicationId', new ParseUUIDPipe()) kycApplicationId: string,
  ) {
    if (!(await this.providers.isTazapayEnabled())) {
      throw new BadRequestException(
        'El envío a Tazapay está desactivado (TAZAPAY_ONBOARDING_ENABLED).',
      );
    }
    const { data: kyc } = await this.supabase
      .from('kyc_applications')
      .select('id, status')
      .eq('id', kycApplicationId)
      .maybeSingle();
    if (!kyc) throw new NotFoundException('Expediente KYC no encontrado');
    if (!['sent_to_bridge', 'approved'].includes(String(kyc.status))) {
      throw new BadRequestException(
        'El expediente todavía no fue aprobado por el staff.',
      );
    }
    return this.providers.sendKycToTazapay(kycApplicationId);
  }

  @Post('kyb/:kybApplicationId/send-to-tazapay')
  @Roles('staff', 'admin', 'super_admin')
  @ApiOperation({
    summary:
      'Enviar a Tazapay un KYB ya aprobado en Bridge (envío pendiente o reenvío asistido)',
  })
  async sendKyb(
    @Param('kybApplicationId', new ParseUUIDPipe()) kybApplicationId: string,
  ) {
    if (!(await this.providers.isTazapayEnabled())) {
      throw new BadRequestException(
        'El envío a Tazapay está desactivado (TAZAPAY_ONBOARDING_ENABLED).',
      );
    }
    const { data: kyb } = await this.supabase
      .from('kyb_applications')
      .select('id, status')
      .eq('id', kybApplicationId)
      .maybeSingle();
    if (!kyb) throw new NotFoundException('Expediente KYB no encontrado');
    if (!['sent_to_bridge', 'approved'].includes(String(kyb.status))) {
      throw new BadRequestException(
        'El expediente todavía no fue aprobado por el staff.',
      );
    }
    return this.providers.sendKybToTazapay(kybApplicationId);
  }
}

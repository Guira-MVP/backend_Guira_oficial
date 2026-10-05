import {
  BadGatewayException,
  Controller,
  ForbiddenException,
  Get,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';
import { CurrentUser } from '../../../core/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../core/guards/supabase-auth.guard';
import { TazapaySwiftEligibilityService } from './tazapay-swift-eligibility.service';
import { TazapayCorridorService } from './tazapay-corridor.service';
import { TazapayBeneficiariesService } from './tazapay-beneficiaries.service';

class CountryQueryDto {
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: 'country debe ser un código de 2 letras',
  })
  country: string;
}

class FormSchemaQueryDto extends CountryQueryDto {
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'currency debe ser un código de 3 letras',
  })
  currency: string;

  @IsOptional()
  @IsIn(['individual', 'business'])
  beneficiary_type?: 'individual' | 'business';
}

class BankSearchQueryDto extends CountryQueryDto {
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  q: string;
}

/** Igual que en SuppliersController: sin onboarding aprobado no se gestionan beneficiarios. */
function assertApproved(user: AuthenticatedUser): void {
  if (user.profile.onboarding_status !== 'approved') {
    throw new ForbiddenException(
      'Tu cuenta todavía no está verificada. Completa tu registro para gestionar beneficiarios.',
    );
  }
}

/**
 * Datos para el formulario de beneficiario SWIFT (Tazapay). Solo lectura: el
 * alta va por POST /suppliers con payment_rail = 'swift'.
 */
@ApiTags('Tazapay SWIFT')
@ApiBearerAuth('supabase-jwt')
@Controller('tazapay/swift')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class TazapaySwiftController {
  constructor(
    private readonly eligibility: TazapaySwiftEligibilityService,
    private readonly corridors: TazapayCorridorService,
    private readonly beneficiaries: TazapayBeneficiariesService,
  ) {}

  @Get('eligibility')
  @ApiOperation({
    summary: 'Si el cliente puede registrar beneficiarios SWIFT',
  })
  async getEligibility(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.eligibility.check(user.id);
    // El entity id de Tazapay no se expone al cliente.
    return {
      eligible: result.eligible,
      reason: result.reason,
      message: result.message,
    };
  }

  @Get('corridors')
  @ApiOperation({ summary: 'Monedas SWIFT disponibles hacia un país' })
  async getCorridors(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CountryQueryDto,
  ) {
    assertApproved(user);
    await this.eligibility.assertEligible(user.id);
    return this.corridors.listCurrencies(query.country);
  }

  @Get('form-schema')
  @ApiOperation({
    summary: 'Campos del formulario de beneficiario para un país y moneda',
  })
  async getFormSchema(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: FormSchemaQueryDto,
  ) {
    assertApproved(user);
    await this.eligibility.assertEligible(user.id);
    return this.corridors.getFormSchema(
      query.country,
      query.currency,
      query.beneficiary_type ?? null,
    );
  }

  @Get('banks')
  @ApiOperation({ summary: 'Buscador de bancos por SWIFT o nombre' })
  async searchBanks(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: BankSearchQueryDto,
  ) {
    assertApproved(user);
    await this.eligibility.assertEligible(user.id);
    try {
      return {
        results: await this.beneficiaries.searchBanks(query.country, query.q),
      };
    } catch {
      throw new BadGatewayException(
        'No pudimos buscar bancos en este momento. Puedes escribir el código SWIFT a mano.',
      );
    }
  }
}

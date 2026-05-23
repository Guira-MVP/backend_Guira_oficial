import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsBoolean,
  IsArray,
  IsEmail,
  Length,
  IsEnum,
  IsNumber,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Bridge-accepted values for business_type.
 * H11 — enforced enum to replace loose string (LLC, Corp, SA, etc.)
 */
export enum BusinessTypeEnum {
  COOPERATIVE = 'cooperative',
  CORPORATION = 'corporation',
  LLC = 'llc',
  OTHER = 'other',
  PARTNERSHIP = 'partnership',
  SOLE_PROP = 'sole_prop',
  TRUST = 'trust',
}

/**
 * Bridge-accepted values for account_purpose (BUSINESS).
 * FIX D-02/N-02: These are DIFFERENT from individual AccountPurposeEnum.
 * Source: customer.md UpdateBusinessCustomerPayload.account_purpose enum.
 */
export enum BusinessAccountPurposeEnum {
  CHARITABLE_DONATIONS = 'charitable_donations',
  ECOMMERCE_RETAIL_PAYMENTS = 'ecommerce_retail_payments',
  INVESTMENT_PURPOSES = 'investment_purposes',
  OTHER = 'other',
  PAYMENTS_TO_FRIENDS_FAMILY_ABROAD = 'payments_to_friends_or_family_abroad',
  PAYROLL = 'payroll',
  PERSONAL_OR_LIVING_EXPENSES = 'personal_or_living_expenses',
  PROTECT_WEALTH = 'protect_wealth',
  PURCHASE_GOODS_AND_SERVICES = 'purchase_goods_and_services',
  RECEIVE_PAYMENTS_GOODS_SERVICES = 'receive_payments_for_goods_and_services',
  TAX_OPTIMIZATION = 'tax_optimization',
  THIRD_PARTY_MONEY_TRANSMISSION = 'third_party_money_transmission',
  TREASURY_MANAGEMENT = 'treasury_management',
}

/**
 * Bridge-accepted values for source_of_funds (BUSINESS).
 * FIX D-01: These are DIFFERENT from individual SourceOfFundsEnum.
 * Source: customer.md UpdateBusinessCustomerPayload.source_of_funds enum.
 */
export enum BusinessSourceOfFundsEnum {
  BUSINESS_LOANS = 'business_loans',
  GRANTS = 'grants',
  INTER_COMPANY_FUNDS = 'inter_company_funds',
  INVESTMENT_PROCEEDS = 'investment_proceeds',
  LEGAL_SETTLEMENT = 'legal_settlement',
  OWNERS_CAPITAL = 'owners_capital',
  PENSION_RETIREMENT = 'pension_retirement',
  SALE_OF_ASSETS = 'sale_of_assets',
  SALES_GOODS_SERVICES = 'sales_of_goods_and_services',
  THIRD_PARTY_FUNDS = 'third_party_funds',
  TREASURY_RESERVES = 'treasury_reserves',
}

export class CreateBusinessDto {
  @ApiProperty({ example: 'Guira Payments S.A. de C.V.' })
  @IsString()
  @IsNotEmpty()
  legal_name: string;

  @ApiPropertyOptional({ example: 'Guira Pay' })
  @IsOptional()
  @IsString()
  trade_name?: string;

  @ApiPropertyOptional({ example: 'REG-123456' })
  @IsOptional()
  @IsString()
  registration_number?: string;

  @ApiProperty({ example: 'GPY1234567A0' })
  @IsString()
  @IsNotEmpty()
  tax_id: string;

  /**
   * H11 — Bridge accepts strict business_type enum.
   * Use BusinessTypeEnum values: llc, corporation, partnership, sole_prop, trust, cooperative, other.
   */
  @ApiProperty({ enum: BusinessTypeEnum })
  @IsEnum(BusinessTypeEnum)
  entity_type: BusinessTypeEnum;

  @ApiPropertyOptional({ example: '2020-01-15' })
  @IsOptional()
  @IsDateString()
  incorporation_date?: string;

  /**
   * H05/H09 — Updated to allow 2-3 char codes. BridgeCustomerService converts to alpha-3.
   */
  @ApiProperty({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code (3 characters preferred)',
  })
  @IsString()
  @Length(2, 3)
  country_of_incorporation: string;

  @ApiPropertyOptional({ example: 'Jalisco' })
  @IsOptional()
  @IsString()
  state_of_incorporation?: string;

  @ApiPropertyOptional({ example: ['MEX', 'USA', 'CHN'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  operating_countries?: string[];

  @ApiPropertyOptional({ example: 'https://guirapay.com' })
  @IsOptional()
  @IsString()
  website?: string;

  @ApiPropertyOptional({
    example: ['https://twitter.com/guirapay', 'https://instagram.com/guirapay'],
    description: 'Otros sitios web y redes sociales del negocio',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other_websites?: string[];

  @ApiProperty({ example: 'contacto@guirapay.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ example: '+525512345678', description: 'Formato E.164: +[código país][número], sin espacios ni guiones' })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'El teléfono debe estar en formato E.164 (ej: +525512345678)' })
  phone?: string;

  @ApiProperty({ example: 'Av. Vallarta 3000' })
  @IsString()
  @IsNotEmpty()
  address1: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address2?: string;

  @ApiProperty({ example: 'Guadalajara' })
  @IsString()
  city: string;

  @ApiPropertyOptional({ example: 'Jalisco' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ example: '44100' })
  @IsOptional()
  @IsString()
  postal_code?: string;

  /**
   * H05 — Bridge requires ISO alpha-3. BridgeCustomerService converts automatically.
   */
  @ApiProperty({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code (3 characters preferred)',
  })
  @IsString()
  @Length(2, 3)
  country: string;

  @ApiPropertyOptional({ example: 'Plataforma de pagos internacionales' })
  @IsOptional()
  @IsString()
  business_description?: string;

  /**
   * P3-A — Bridge accepts `is_dao` boolean.
   * Indicates if the business is a DAO (Decentralized Autonomous Organization).
   * Defaults to false in the payload builder if not provided.
   */
  @ApiPropertyOptional({
    example: false,
    description: 'Whether the business is a DAO (Decentralized Autonomous Organization)',
  })
  @IsOptional()
  @IsBoolean()
  is_dao?: boolean;

  @ApiPropertyOptional({ example: ['fintech'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  business_industry?: string[];

  @ApiPropertyOptional({ example: 50000 })
  @IsOptional()
  @IsNumber()
  expected_monthly_payments_usd?: number;

  @ApiPropertyOptional({ enum: BusinessAccountPurposeEnum })
  @IsOptional()
  @IsEnum(BusinessAccountPurposeEnum)
  account_purpose?: BusinessAccountPurposeEnum;

  @ApiPropertyOptional({ enum: BusinessSourceOfFundsEnum })
  @IsOptional()
  @IsEnum(BusinessSourceOfFundsEnum)
  source_of_funds?: BusinessSourceOfFundsEnum;

  @ApiPropertyOptional({ example: 'Custom purpose description' })
  @IsOptional()
  @IsString()
  account_purpose_other?: string;

  @ApiPropertyOptional({ example: 'Description of funds' })
  @IsOptional()
  @IsString()
  source_of_funds_description?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  conducts_money_services?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  uses_bridge_for_money_services?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  acting_as_intermediary?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  operates_in_prohibited_countries?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  compliance_explanation?: string;

  @ApiPropertyOptional({
    description:
      'Descripción de los servicios de dinero ofrecidos. Requerido por Bridge cuando conducts_money_services=true.',
  })
  @IsOptional()
  @IsString()
  conducts_money_services_description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  high_risk_activities_explanation?: string;

  // ── P1: High-risk / Enhanced Due Diligence ──────────────────────────

  @ApiPropertyOptional({
    enum: [
      '0_99999',
      '100000_999999',
      '1000000_9999999',
      '10000000_49999999',
      '50000000_249999999',
      '250000000_plus',
    ],
  })
  @IsOptional()
  @IsEnum([
    '0_99999',
    '100000_999999',
    '1000000_9999999',
    '10000000_49999999',
    '50000000_249999999',
    '250000000_plus',
  ])
  estimated_annual_revenue_usd?:
    | '0_99999'
    | '100000_999999'
    | '1000000_9999999'
    | '10000000_49999999'
    | '50000000_249999999'
    | '250000000_plus';

  @ApiPropertyOptional({ example: ['money_services', 'gambling'] })
  @IsOptional()
  @IsArray()
  @IsEnum(
    [
      'adult_entertainment',
      'gambling',
      'hold_client_funds',
      'investment_services',
      'lending_banking',
      'marijuana_or_related_services',
      'money_services',
      'nicotine_tobacco_or_related_services',
      'operate_foreign_exchange_virtual_currencies_brokerage_otc',
      'pharmaceuticals',
      'precious_metals_precious_stones_jewelry',
      'safe_deposit_box_rentals',
      'third_party_payment_processing',
      'weapons_firearms_and_explosives',
      'none_of_the_above',
    ],
    { each: true },
  )
  high_risk_activities?: string[];

  // ── P2: Physical / Operational Address ─────────────────────────────

  @ApiPropertyOptional({ example: 'Calle Industria 55' })
  @IsOptional()
  @IsString()
  physical_address1?: string;

  @ApiPropertyOptional({ example: 'Piso 2' })
  @IsOptional()
  @IsString()
  physical_address2?: string;

  @ApiPropertyOptional({ example: 'Monterrey' })
  @IsOptional()
  @IsString()
  physical_city?: string;

  @ApiPropertyOptional({ example: 'Nuevo León' })
  @IsOptional()
  @IsString()
  physical_state?: string;

  @ApiPropertyOptional({ example: '64000' })
  @IsOptional()
  @IsString()
  physical_postal_code?: string;

  @ApiPropertyOptional({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code for physical location',
  })
  @IsOptional()
  @IsString()
  @Length(2, 3)
  physical_country?: string;
}

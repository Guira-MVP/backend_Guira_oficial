import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsEmail,
  IsBoolean,
  IsEnum,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Bridge-accepted values for source_of_funds (individual).
 * Updated to Bridge API OpenAPI spec (replaces previous Guira-specific enum).
 */
export enum SourceOfFundsEnum {
  SALARY = 'salary',
  SAVINGS = 'savings',
  COMPANY_FUNDS = 'company_funds',
  INVESTMENTS_LOANS = 'investments_loans',
  GOVERNMENT_BENEFITS = 'government_benefits',
  PENSION_RETIREMENT = 'pension_retirement',
  INHERITANCE = 'inheritance',
  GIFTS = 'gifts',
  SALE_OF_ASSETS = 'sale_of_assets_real_estate',
  ECOMMERCE_RESELLER = 'ecommerce_reseller',
  SOMEONE_ELSES_FUNDS = 'someone_elses_funds',
  GAMBLING_PROCEEDS = 'gambling_proceeds',
}

/**
 * Bridge-accepted values for account_purpose (individual).
 * Updated to Bridge API OpenAPI spec.
 */
export enum AccountPurposeEnum {
  PAYMENTS_TO_FRIENDS_OR_FAMILY_ABROAD = 'payments_to_friends_or_family_abroad',
  PERSONAL_OR_LIVING_EXPENSES = 'personal_or_living_expenses',
  RECEIVE_SALARY = 'receive_salary',
  PURCHASE_GOODS_AND_SERVICES = 'purchase_goods_and_services',
  RECEIVE_PAYMENT_FOR_FREELANCING = 'receive_payment_for_freelancing',
  INVESTMENT_PURPOSES = 'investment_purposes',
  OPERATING_A_COMPANY = 'operating_a_company',
  ECOMMERCE_RETAIL_PAYMENTS = 'ecommerce_retail_payments',
  CHARITABLE_DONATIONS = 'charitable_donations',
  PROTECT_WEALTH = 'protect_wealth',
  OTHER = 'other',
}

export class CreatePersonDto {
  @ApiProperty({ example: 'María' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 100)
  first_name: string;

  @ApiProperty({ example: 'González' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 100)
  last_name: string;

  /** Bridge optional: middle_name */
  @ApiPropertyOptional({ example: 'Elena' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  middle_name?: string;

  @ApiProperty({ example: '1990-05-15' })
  @IsDateString()
  date_of_birth: string;

  /**
   * H09 — Bridge requires ISO alpha-3 (3 chars, e.g. 'MEX').
   * The BridgeCustomerService will convert alpha-2 to alpha-3 automatically,
   * but accepting Length(3) here enforces the correct format at entry point.
   * Updated MaxLength from 2 to 3.
   */
  @ApiPropertyOptional({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code (3 characters)',
  })
  @IsOptional()
  @IsString()
  @Length(2, 3)
  nationality?: string;

  @ApiPropertyOptional({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code of residence (3 characters)',
  })
  @IsOptional()
  @IsString()
  @Length(2, 3)
  country_of_residence?: string;

  @ApiProperty({ enum: ['passport', 'drivers_license', 'national_id'] })
  @IsEnum(['passport', 'drivers_license', 'national_id'])
  id_type: string;

  @ApiProperty({ example: 'G12345678' })
  @IsString()
  @IsNotEmpty()
  id_number: string;

  @ApiPropertyOptional({ example: '2030-12-31' })
  @IsOptional()
  @IsDateString()
  id_expiry_date?: string;

  @ApiProperty({ example: 'maria@ejemplo.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '+52 55 1234 5678' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({ example: 'Av. Reforma 123' })
  @IsString()
  @IsNotEmpty()
  address1: string;

  @ApiPropertyOptional({ example: 'Piso 4' })
  @IsOptional()
  @IsString()
  address2?: string;

  @ApiProperty({ example: 'Ciudad de México' })
  @IsString()
  @IsNotEmpty()
  city: string;

  @ApiPropertyOptional({ example: 'CDMX' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ example: '06600' })
  @IsOptional()
  @IsString()
  postal_code?: string;

  /**
   * H05 — Bridge requires ISO alpha-3. BridgeCustomerService converts automatically.
   * Updated MaxLength from 2 to 3 to accept alpha-3 at entry too.
   */
  @ApiProperty({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code (3 characters preferred)',
  })
  @IsString()
  @Length(2, 3)
  country: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tax_id?: string;

  /** H10 — enforced Bridge enum */
  @ApiPropertyOptional({ enum: SourceOfFundsEnum })
  @IsOptional()
  @IsEnum(SourceOfFundsEnum)
  source_of_funds?: SourceOfFundsEnum;

  /** H10 — enforced Bridge enum */
  @ApiPropertyOptional({ enum: AccountPurposeEnum })
  @IsOptional()
  @IsEnum(AccountPurposeEnum)
  account_purpose?: AccountPurposeEnum;

  /** Required when account_purpose = 'other' */
  @ApiPropertyOptional({ example: 'Custom purpose description' })
  @IsOptional()
  @IsString()
  account_purpose_other?: string;

  @ApiProperty({ example: false })
  @IsBoolean()
  is_pep: boolean;

  /**
   * P1 — Bridge high-risk field.
   * Updated to match Bridge API OpenAPI spec (homemaker added, other removed).
   */
  @ApiPropertyOptional({
    enum: [
      'employed',
      'self_employed',
      'unemployed',
      'student',
      'retired',
      'homemaker',
    ],
  })
  @IsOptional()
  @IsEnum([
    'employed',
    'self_employed',
    'unemployed',
    'student',
    'retired',
    'homemaker',
  ])
  employment_status?:
    | 'employed'
    | 'self_employed'
    | 'unemployed'
    | 'student'
    | 'retired'
    | 'homemaker';

  /**
   * P1 — Bridge high-risk field.
   * Updated to match Bridge API OpenAPI spec enum values.
   */
  @ApiPropertyOptional({
    enum: ['0_4999', '5000_9999', '10000_49999', '50000_plus'],
  })
  @IsOptional()
  @IsEnum(['0_4999', '5000_9999', '10000_49999', '50000_plus'])
  expected_monthly_payments_usd?:
    | '0_4999'
    | '5000_9999'
    | '10000_49999'
    | '50000_plus';

  /**
   * Bridge field — alphanumeric occupation code from Bridge occupation list.
   * Required for high-risk customers and restricted countries.
   * Ref: https://apidocs.bridge.xyz/platform/customers/compliance/sof-eu-most-recent-occupation-list
   */
  @ApiPropertyOptional({
    example: '222111',
    description: 'Bridge occupation code (alphanumeric)',
  })
  @IsOptional()
  @IsString()
  most_recent_occupation?: string;
}

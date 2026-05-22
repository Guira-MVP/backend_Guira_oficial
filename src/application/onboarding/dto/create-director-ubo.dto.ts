import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsBoolean,
  IsEmail,
  Length,
  IsEnum,
  IsNumber,
  Matches,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDirectorDto {
  @ApiProperty({ example: 'Carlos' })
  @IsString()
  @IsNotEmpty()
  first_name: string;

  @ApiProperty({ example: 'Slim' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 1024)
  last_name: string;

  /**
   * Position/title of the director (maps to Bridge `title` field).
   * H03 — bridge associated_person uses `title`; stored as `position` in DB.
   */
  @ApiProperty({ example: 'CEO' })
  @IsString()
  @IsNotEmpty()
  position: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  is_signer: boolean;

  /**
   * FIX N-05 — Bridge AssociatedPerson schema marks birth_date as REQUIRED.
   * Changed from @IsOptional() to required.
   */
  @ApiProperty({ example: '1975-03-10' })
  @IsDateString()
  @IsNotEmpty()
  date_of_birth: string;

  /**
   * H09 — Updated to accept alpha-3 (3 chars). BridgeCustomerService converts.
   */
  @ApiPropertyOptional({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 nationality code',
  })
  @IsOptional()
  @IsString()
  @Length(2, 3)
  nationality?: string;

  @ApiPropertyOptional({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country of residence',
  })
  @IsOptional()
  @IsString()
  @Length(2, 3)
  country_of_residence?: string;

  @ApiProperty({ enum: ['passport', 'drivers_license', 'national_id'] })
  @IsEnum(['passport', 'drivers_license', 'national_id'])
  id_type: string;

  @ApiProperty({ example: 'G98765432' })
  @IsString()
  @IsNotEmpty()
  id_number: string;

  @ApiPropertyOptional({ example: '2030-12-31' })
  @IsOptional()
  @IsDateString()
  id_expiry_date?: string;

  /**
   * FIX N-05 — Bridge AssociatedPerson schema marks email as REQUIRED.
   * Changed from @IsOptional() to required.
   */
  @ApiProperty({ example: 'carlos@empresa.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ description: 'Formato E.164: +[código país][número], sin espacios ni guiones' })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'El teléfono debe estar en formato E.164 (ej: +525512345678)' })
  phone?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  address1: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  city: string;

  /**
   * H05 — Updated to accept alpha-3. BridgeCustomerService converts.
   */
  @ApiProperty({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code',
  })
  @IsString()
  @Length(2, 3)
  country: string;

  /**
   * Fuga B — Bridge requires PEP status for all associated_persons including directors.
   * Stored in business_directors.is_pep (NOT NULL DEFAULT false).
   */
  @ApiProperty({
    example: false,
    description: 'Persona Políticamente Expuesta (PEP)',
  })
  @IsBoolean()
  is_pep: boolean;
}

export class CreateUboDto {
  @ApiProperty({ example: 'Ana' })
  @IsString()
  @IsNotEmpty()
  first_name: string;

  @ApiProperty({ example: 'Martínez' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 1024)
  last_name: string;

  /** ownership_percentage on Bridge side; stored as ownership_percent in DB. */
  @ApiProperty({ example: 51.5 })
  @IsNumber()
  @Min(0)
  @Max(100)
  ownership_percent: number;

  /**
   * FIX N-05 — Bridge AssociatedPerson schema marks birth_date as REQUIRED.
   * Changed from @IsOptional() to required.
   */
  @ApiProperty({ example: '1980-08-22' })
  @IsDateString()
  @IsNotEmpty()
  date_of_birth: string;

  @ApiPropertyOptional({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 nationality code',
  })
  @IsOptional()
  @IsString()
  @Length(2, 3)
  nationality?: string;

  @ApiPropertyOptional({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country of residence',
  })
  @IsOptional()
  @IsString()
  @Length(2, 3)
  country_of_residence?: string;

  @ApiProperty({ enum: ['passport', 'drivers_license', 'national_id'] })
  @IsEnum(['passport', 'drivers_license', 'national_id'])
  id_type: string;

  @ApiProperty({ example: 'G98765432' })
  @IsString()
  @IsNotEmpty()
  id_number: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  id_expiry_date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tax_id?: string;

  /**
   * FIX N-05 — Bridge AssociatedPerson schema marks email as REQUIRED.
   * Changed from @IsOptional() to required.
   */
  @ApiProperty({ example: 'ana@empresa.com' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ description: 'Formato E.164: +[código país][número], sin espacios ni guiones' })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'El teléfono debe estar en formato E.164 (ej: +525512345678)' })
  phone?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  address1: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address2?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  city: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  postal_code?: string;

  /**
   * H05 — Updated to accept alpha-3. BridgeCustomerService converts.
   */
  @ApiProperty({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code',
  })
  @IsString()
  @Length(2, 3)
  country: string;

  @ApiProperty({ example: false })
  @IsBoolean()
  is_pep: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Indica si el UBO también firma documentos corporativos en nombre de la empresa.',
  })
  @IsOptional()
  @IsBoolean()
  is_signer?: boolean;

  /**
   * Fuga A — Control prong: indicates whether the UBO also exerts operational
   * control over the business (FinCEN Control Prong).
   * Stored in business_ubos.has_control (NOT NULL DEFAULT false).
   */
  @ApiPropertyOptional({
    example: false,
    description:
      'El UBO también tiene control operacional sobre la empresa (FinCEN Control Prong)',
  })
  @IsOptional()
  @IsBoolean()
  has_control?: boolean;

  /**
   * P2-A — Bridge requires `title` when has_control is true.
   * Stored as `position` in DB, mapped to Bridge `title` in buildAssociatedPersons.
   */
  @ApiPropertyOptional({
    example: 'CFO',
    description:
      'Cargo del UBO en la empresa. Requerido por Bridge cuando has_control=true.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 1024)
  position?: string;
}

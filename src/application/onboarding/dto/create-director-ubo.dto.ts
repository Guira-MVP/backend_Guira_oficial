import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDateString,
  IsISO8601,
  IsBoolean,
  IsEmail,
  Length,
  IsEnum,
  IsInt,
  Matches,
  Min,
  Max,
  IsUUID,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateDirectorDto {
  @ApiProperty({ example: 'Carlos' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  first_name: string;

  @ApiProperty({ example: 'Slim' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @Length(2, 1024)
  last_name: string;

  /**
   * Position/title of the director (maps to Bridge `title` field).
   * H03 — bridge associated_person uses `title`; stored as `position` in DB.
   */
  @ApiProperty({ example: 'CEO' })
  @Transform(trimString)
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
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 3)
  nationality?: string;

  @ApiPropertyOptional({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country of residence',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 3)
  country_of_residence?: string;

  @ApiProperty({ enum: ['passport', 'drivers_license', 'national_id'] })
  @IsEnum(['passport', 'drivers_license', 'national_id'])
  id_type: string;

  @ApiProperty({ example: 'G98765432' })
  @Transform(trimString)
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
  @Transform(trimString)
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ description: 'Formato E.164: +[código país][número], sin espacios ni guiones' })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'El teléfono debe estar en formato E.164 (ej: +525512345678)' })
  phone?: string;

  @ApiProperty()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  address1: string;

  @ApiProperty()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  city: string;

  /**
   * Bridge exige `residential_address.subdivision` para ciertos países (ej. Bolivia) —
   * confirmado contra Bridge real el 2026-07-29 ("must be set for provided country").
   * Opcional aquí porque solo aplica quando el país tiene subdivisiones definidas
   * (mismo criterio que ya usa el domicilio de la empresa).
   */
  @ApiPropertyOptional({ example: 'La Paz' })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  state?: string;

  /**
   * H05 — Updated to accept alpha-3. BridgeCustomerService converts.
   */
  @ApiProperty({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code',
  })
  @Transform(trimString)
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

  /**
   * Bridge AssociatedPerson.attested_ownership_structure_at — required to satisfy
   * Bridge's control_person_ownership_attestation without a separate ownership
   * document. Set when the legal representative (control person) certifies that
   * the declared UBO list represents 100% of the ownership structure.
   */
  @ApiPropertyOptional({
    example: '2026-07-29T18:32:00.000Z',
    description:
      'Timestamp ISO 8601 en el que este director (persona de control) certificó la estructura de propiedad (UBOs) de la empresa.',
  })
  @IsOptional()
  @IsISO8601()
  attested_ownership_structure_at?: string;
}

export class CreateUboDto {
  @ApiProperty({ example: 'Ana' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  first_name: string;

  @ApiProperty({ example: 'Martínez' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @Length(2, 1024)
  last_name: string;

  /**
   * ownership_percentage on Bridge side; stored as ownership_percent in DB.
   * Bridge spec types this field as `integer` — decimals cause a 400 on
   * POST /v0/customers, so this is validated as a whole number.
   */
  @ApiProperty({ example: 51 })
  @IsInt({ message: 'ownership_percent debe ser un número entero (Bridge no acepta decimales)' })
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
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 3)
  nationality?: string;

  @ApiPropertyOptional({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country of residence',
  })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(2, 3)
  country_of_residence?: string;

  @ApiProperty({ enum: ['passport', 'drivers_license', 'national_id'] })
  @IsEnum(['passport', 'drivers_license', 'national_id'])
  id_type: string;

  @ApiProperty({ example: 'G98765432' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  id_number: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  id_expiry_date?: string;

  @ApiPropertyOptional()
  @Transform(trimString)
  @IsOptional()
  @IsString()
  tax_id?: string;

  /**
   * FIX N-05 — Bridge AssociatedPerson schema marks email as REQUIRED.
   * Changed from @IsOptional() to required.
   */
  @ApiProperty({ example: 'ana@empresa.com' })
  @Transform(trimString)
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiPropertyOptional({ description: 'Formato E.164: +[código país][número], sin espacios ni guiones' })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'El teléfono debe estar en formato E.164 (ej: +525512345678)' })
  phone?: string;

  // Bridge (Address2025WinterRefresh) solo requiere street_line_1/city/country — address2/postal_code
  // eliminados: sin input en el form, nunca poblados (auditoria 2026-07-28).
  @ApiProperty()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  address1: string;

  @ApiProperty()
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  city: string;

  /**
   * Bridge exige `residential_address.subdivision` para ciertos países (ej. Bolivia) —
   * confirmado contra Bridge real el 2026-07-29. La columna `business_ubos.state` ya
   * existía en BD (huérfana desde la limpieza del 2026-07-28); se reactiva aquí.
   */
  @ApiPropertyOptional({ example: 'La Paz' })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  state?: string;

  /**
   * H05 — Updated to accept alpha-3. BridgeCustomerService converts.
   */
  @ApiProperty({
    example: 'MEX',
    description: 'ISO 3166-1 alpha-3 country code',
  })
  @Transform(trimString)
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
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @Length(1, 1024)
  position?: string;

  /**
   * H13-FIX: cuando este UBO representa a la MISMA persona física que un
   * director ya registrado (ej. el representante legal que también es
   * dueño), se linkea aquí para que buildAssociatedPersons() los fusione en
   * un solo associated_person hacia Bridge en vez de enviar dos personas
   * separadas para el mismo individuo.
   */
  @ApiPropertyOptional({
    description:
      'ID del business_directors al que representa esta misma persona (si aplica). Evita duplicar a la persona en el payload de Bridge.',
  })
  @IsOptional()
  @IsUUID()
  director_id?: string;

  /**
   * AUDIT 2026-07-31: Bridge acepta `is_director` en cada AssociatedPerson y
   * lo exige bajo politica EEA/BBSA (lista completa de directores). Antes solo
   * se enviaba para las filas de business_directors.
   */
  @ApiPropertyOptional({
    example: false,
    description: 'El UBO tambien es director designado de la empresa.',
  })
  @IsOptional()
  @IsBoolean()
  is_director?: boolean;
}

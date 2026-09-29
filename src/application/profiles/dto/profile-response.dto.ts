import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO de respuesta para endpoints que retornan un perfil completo.
 * Mapea directamente las columnas de la tabla `profiles`.
 */
export class ProfileResponseDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  id: string;

  @ApiProperty({ example: 'usuario@ejemplo.com' })
  email: string;

  @ApiPropertyOptional({ example: 'María González' })
  full_name: string | null;

  @ApiProperty({ enum: ['client', 'staff', 'admin', 'super_admin'] })
  role: string;

  @ApiProperty({
    example: 'pending',
    enum: ['pending', 'in_review', 'approved', 'rejected'],
  })
  onboarding_status: string;

  @ApiPropertyOptional()
  bridge_customer_id: string | null;

  @ApiProperty({ example: true })
  is_active: boolean;

  @ApiProperty({ example: false })
  is_frozen: boolean;

  @ApiPropertyOptional({ example: 'Actividad sospechosa reportada' })
  frozen_reason: string | null;

  /**
   * Si esta persona puede consultar la cuenta de alguna empresa que la
   * invitó a su equipo. Solo sirve para decidir a dónde enrutarla al
   * entrar: quien no tiene empresa propia nunca completa el KYB, y sin
   * este dato quedaría atrapado en /onboarding.
   */
  @ApiPropertyOptional({ example: false })
  has_linked_accounts?: boolean;

  /**
   * El onboarding espera una acción del cliente: solicitud asistida lista
   * para revisar, o correcciones pedidas por compliance. Decide si entra al
   * onboarding o al panel al iniciar sesión.
   */
  @ApiPropertyOptional({ example: false })
  onboarding_action_required?: boolean;

  @ApiPropertyOptional({ example: 10000 })
  daily_limit_usd: number | null;

  @ApiPropertyOptional({ example: 50000 })
  monthly_limit_usd: number | null;

  @ApiPropertyOptional({ example: '+1 415-555-0100' })
  phone: string | null;

  @ApiPropertyOptional()
  avatar_url: string | null;

  /**
   * Tipo de cuenta: nace como la intención declarada al registrarse y se
   * sincroniza con la solicitud enviada (KYC → personal, KYB → company).
   * Informativo: no decide comisiones, límites ni permisos.
   */
  @ApiPropertyOptional({ enum: ['personal', 'company'], nullable: true })
  account_type?: 'personal' | 'company' | null;

  /**
   * Datos declarados en el registro (empresa + representante legal). Sirven
   * para precargar el onboarding e identificar la cuenta antes de que exista
   * una solicitud; lo que llega a Bridge es lo que se envía en el onboarding.
   */
  @ApiPropertyOptional({ example: 'Importadora Andina S.R.L.' })
  company_name?: string | null;

  @ApiPropertyOptional({ example: '1020304025', description: 'NIT' })
  tax_id?: string | null;

  @ApiPropertyOptional({ example: 'María José' })
  contact_first_name?: string | null;

  @ApiPropertyOptional({ example: 'Pérez Gómez' })
  contact_last_name?: string | null;

  @ApiPropertyOptional({ example: '1234567 LP', description: 'CI del contacto' })
  contact_id_number?: string | null;

  @ApiProperty()
  created_at: string;

  @ApiProperty()
  updated_at: string;
}

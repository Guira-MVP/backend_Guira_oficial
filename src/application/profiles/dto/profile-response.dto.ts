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

  @ApiPropertyOptional({ example: 10000 })
  daily_limit_usd: number | null;

  @ApiPropertyOptional({ example: 50000 })
  monthly_limit_usd: number | null;

  @ApiPropertyOptional({ example: '+1 415-555-0100' })
  phone: string | null;

  @ApiPropertyOptional()
  avatar_url: string | null;

  @ApiProperty()
  created_at: string;

  @ApiProperty()
  updated_at: string;
}

import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token proporcionado por Supabase Auth' })
  @IsString()
  @IsNotEmpty()
  refresh_token: string;
}

/** Respuesta estándar de auth (register / refresh) */
export class AuthResponseDto {
  user_id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  onboarding_status: string;
}

/** Respuesta de /auth/me */
export class MeResponseDto {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  onboarding_status: string;
  bridge_customer_id: string | null;
  is_active: boolean;
  is_frozen: boolean;
  phone: string | null;
  avatar_url: string | null;
  daily_limit_usd: number | null;
  monthly_limit_usd: number | null;
  created_at: string;
}

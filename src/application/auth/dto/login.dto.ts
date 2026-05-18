import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO para el endpoint POST /auth/login.
 * Valida las credenciales del usuario antes de delegarlas a Supabase Auth.
 * El backend aplica rate limiting y logging de eventos de autenticación.
 */
export class LoginDto {
  @ApiProperty({
    example: 'usuario@ejemplo.com',
    description: 'Correo electrónico del usuario',
  })
  @IsEmail({}, { message: 'Debe ser un email válido' })
  @IsNotEmpty({ message: 'El correo electrónico es requerido' })
  email: string;

  @ApiProperty({
    example: '••••••••',
    description: 'Contraseña del usuario',
  })
  @IsString()
  @IsNotEmpty({ message: 'La contraseña es requerida' })
  password: string;
}

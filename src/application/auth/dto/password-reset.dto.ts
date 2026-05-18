import { IsEmail, IsNotEmpty, IsString, IsStrongPassword } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Correo electrónico del usuario que olvidó su contraseña',
  })
  @IsEmail({}, { message: 'El formato del correo es inválido' })
  @IsNotEmpty({ message: 'El correo electrónico es requerido' })
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({
    example: 'NewSecurePass123!',
    description:
      'Nueva contraseña (mínimo 12 caracteres, 1 mayúscula, 1 minúscula, 1 número, 1 símbolo)',
    minLength: 12,
  })
  @IsString()
  @IsNotEmpty({ message: 'La nueva contraseña es requerida' })
  @IsStrongPassword(
    {
      minLength: 12,
      minLowercase: 1,
      minUppercase: 1,
      minNumbers: 1,
      minSymbols: 1,
    },
    {
      message:
        'La contraseña debe tener al menos 12 caracteres, 1 mayúscula, 1 minúscula, 1 número y 1 carácter especial',
    },
  )
  new_password: string;
}

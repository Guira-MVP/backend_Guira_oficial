import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO para el endpoint POST /auth/oauth-callback.
 * Registra el proveedor OAuth utilizado para la autenticación.
 */
export class OAuthCallbackDto {
  @ApiProperty({
    example: 'google',
    description: 'Proveedor OAuth utilizado (google, github, etc.)',
  })
  @IsString()
  @IsNotEmpty({ message: 'El proveedor OAuth es requerido' })
  provider: string;
}

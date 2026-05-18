import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'usuario@ejemplo.com' })
  @IsEmail({}, { message: 'Debe ser un email válido' })
  @IsNotEmpty()
  email: string;

  @ApiProperty({ example: 'María González' })
  @IsString()
  @IsNotEmpty({ message: 'El nombre completo es requerido' })
  @MaxLength(200)
  full_name: string;
}

import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FreezeAccountDto {
  @ApiProperty({
    example: true,
    description: 'true para congelar, false para descongelar',
  })
  @IsBoolean()
  freeze: boolean;

  @ApiPropertyOptional({
    example: 'Actividad sospechosa reportada por compliance',
    description: 'Motivo del congelamiento (requerido al congelar)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ActivateAccountDto {
  @ApiProperty({
    example: true,
    description: 'true para activar, false para desactivar',
  })
  @IsBoolean()
  is_active: boolean;
}

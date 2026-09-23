import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  Max,
  Min,
} from 'class-validator';

/**
 * Borrador del formulario de onboarding. `data` es un objeto opaco (el
 * cliente todavía no terminó de llenarlo, así que no se valida contra los
 * DTOs de envío): el servicio limita tamaño, profundidad y claves.
 */
export class SaveOnboardingDraftDto {
  @ApiProperty({ enum: ['personal', 'company'] })
  @IsIn(['personal', 'company'])
  type!: 'personal' | 'company';

  @ApiProperty({ minimum: 1, maximum: 6 })
  @IsInt()
  @Min(1)
  @Max(6)
  step!: number;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  data!: Record<string, unknown>;

  @ApiProperty({
    description:
      'Campos faltantes calculados por el formulario: [{ key, label, step, reason, message }]',
    type: 'array',
    items: { type: 'object' },
  })
  @IsArray()
  @ArrayMaxSize(300)
  missing_fields!: unknown[];

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  progress_pct!: number;
}

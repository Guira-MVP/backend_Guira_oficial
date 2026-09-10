import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Activa o desactiva la puerta de revisión de staff en un flujo concreto.
 *
 * Apagarla NO afecta a los expedientes que ya están en 'pending_review': esos
 * siguen necesitando una decisión del staff. Solo cambia el comportamiento de
 * los expedientes que se creen a partir de ese momento.
 */
export class UpdateFlowReviewSettingDto {
  @ApiProperty({
    description:
      'true = el expediente nace en pending_review y no se ejecuta hasta que el staff lo apruebe.',
  })
  @IsBoolean()
  requires_staff_review: boolean;
}

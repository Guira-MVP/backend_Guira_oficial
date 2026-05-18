import {
  IsString,
  IsNotEmpty,
  IsBoolean,
  IsOptional,
  IsUUID,
  IsNumber,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveReviewDto {
  @ApiProperty({
    example: 'KYC validado satisfactoriamente contra base de datos OFAC.',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class RejectReviewDto {
  @ApiProperty({ example: 'Documento de identidad no legible.' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class RequestChangesDto {
  @ApiProperty({
    example: 'Por favor suba una fotografía más nítida del pasaporte.',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({
    description: 'Lista de campos o documentos específicos a corregir',
  })
  @IsOptional()
  required_actions?: string[];

  @ApiPropertyOptional({
    description:
      'Observaciones por campo. Clave = nombre del campo del formulario, valor = mensaje de error.',
    example: {
      id_front: 'Imagen borrosa, favor resubir en mejor resolución',
      address1: 'No coincide con el comprobante de domicilio presentado',
    },
  })
  @IsOptional()
  field_observations?: Record<string, string>;
}

export class AddCommentDto {
  @ApiProperty({ example: 'Cliente requiere verificación adicional de UBOs' })
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  is_internal?: boolean;
}

export class AssignReviewDto {
  @ApiProperty({ description: 'UUID del analista (Staff)' })
  @IsUUID()
  @IsNotEmpty()
  staff_user_id: string;
}

export class SetLimitsDto {
  @ApiPropertyOptional()
  @IsNumber()
  @Min(0)
  @IsOptional()
  daily_deposit_limit?: number;

  @ApiPropertyOptional()
  @IsNumber()
  @Min(0)
  @IsOptional()
  daily_payout_limit?: number;

  @ApiPropertyOptional()
  @IsNumber()
  @Min(0)
  @IsOptional()
  single_txn_limit?: number;

  @ApiProperty({ example: 'Aumento de límites solicitado por el cliente VIP' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

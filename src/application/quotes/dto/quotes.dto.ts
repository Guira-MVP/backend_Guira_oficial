import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsIn,
  IsBoolean,
  IsArray,
  Min,
  Max,
  MaxLength,
  Matches,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Una fila de la sección "Otras opciones" / "Fondea sin comisión" del PDF.
 * Calculada y congelada en el frontend al momento de generar la cotización
 * (ver features/staff/lib/build-quote-comparison.ts), para que el PDF sea
 * siempre reproducible con los mismos números mostrados al cliente.
 */
export class ComparisonFlowRowDto {
  @ApiProperty({ enum: ['destination_alternative', 'funding_benefit'] })
  @IsIn(['destination_alternative', 'funding_benefit'])
  kind: 'destination_alternative' | 'funding_benefit';

  @ApiProperty({ example: 'bolivia_to_world' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  flow: string;

  @ApiProperty({ example: 'Estados Unidos' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label: string;

  @ApiPropertyOptional({ example: 'US' })
  @IsString()
  @IsOptional()
  @MaxLength(8)
  destination_country?: string;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8)
  destination_currency: string;

  @ApiProperty({ example: 3 })
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_percent: number;

  @ApiPropertyOptional({ example: 6.96 })
  @IsNumber()
  @IsOptional()
  exchange_rate?: number;

  @ApiProperty({ example: 965.5 })
  @IsNumber()
  @Min(0)
  receives_amount: number;

  @ApiProperty({ default: false })
  @IsBoolean()
  is_primary: boolean;
}

export class CreateQuoteDto {
  @ApiProperty({ example: 'bolivia_to_world' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  flow: string;

  @ApiProperty({ example: 'Enviar de Bolivia al exterior' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  flow_label: string;

  @ApiProperty({ example: 'BOB' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8)
  origin_currency: string;

  @ApiProperty({ example: 'BRL' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8)
  destination_currency: string;

  @ApiPropertyOptional({ example: 'pix' })
  @IsString()
  @IsOptional()
  @MaxLength(40)
  payment_rail?: string;

  @ApiProperty({ example: 10000 })
  @IsNumber()
  @Min(0.01)
  amount_origin: number;

  @ApiPropertyOptional({ example: 0.72 })
  @IsNumber()
  @IsOptional()
  exchange_rate?: number;

  @ApiProperty({ example: 2.5, description: 'Comisión negociada para esta cotización (override puntual, no toca fees_config).' })
  @IsNumber()
  @Min(0)
  @Max(100)
  commission_percent: number;

  @ApiProperty({ example: 250 })
  @IsNumber()
  @Min(0)
  commission_amount: number;

  @ApiProperty({ example: 1.5, description: 'Spread negociado para esta cotización (override puntual, no toca exchange_rates_config).' })
  @IsNumber()
  @Min(0)
  @Max(20)
  spread_percent: number;

  @ApiProperty({ example: 9750 })
  @IsNumber()
  @Min(0)
  net_amount: number;

  @ApiProperty({ example: 7020 })
  @IsNumber()
  @Min(0)
  receives_amount: number;

  @ApiProperty({ example: '+591 700 00000' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(/^[0-9+\-\s()]{6,30}$/, { message: 'Teléfono inválido' })
  client_phone: string;

  @ApiPropertyOptional({ example: 'Juana Pérez' })
  @IsString()
  @IsOptional()
  @MaxLength(160)
  client_name?: string;

  @ApiPropertyOptional({ example: 'Importadora Pérez SRL' })
  @IsString()
  @IsOptional()
  @MaxLength(160)
  client_company?: string;

  @ApiPropertyOptional({ example: 'Cliente mueve ~$20k/mes, negociar comisión preferencial.' })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ type: [ComparisonFlowRowDto] })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ComparisonFlowRowDto)
  comparison_flows?: ComparisonFlowRowDto[];

  @ApiPropertyOptional({
    default: false,
    description: 'El spread es un dato interno; por defecto NO se revela al cliente en el ticket.',
  })
  @IsBoolean()
  @IsOptional()
  show_spread_to_client?: boolean;
}

import {
  IsNumber,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsEnum,
  IsIn,
  Min,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ALLOWED_NETWORKS,
  ALLOWED_CRYPTO_CURRENCIES,
} from '../../../common/constants/guira-crypto-config.constants';

export enum InterbankFlowType {
  BOLIVIA_TO_WORLD = 'bolivia_to_world',
  WALLET_TO_WALLET = 'wallet_to_wallet',
  BOLIVIA_TO_WALLET = 'bolivia_to_wallet',
  WORLD_TO_BOLIVIA = 'world_to_bolivia',
  WORLD_TO_WALLET = 'world_to_wallet',
}

export class CreateInterbankOrderDto {
  @ApiProperty({ enum: InterbankFlowType })
  @IsEnum(InterbankFlowType)
  flow_type: InterbankFlowType;

  @ApiProperty({ example: 1000.0 })
  @IsNumber()
  @Min(0.01)
  amount: number;

  // ── bolivia_to_world: destino es external_account ──
  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'bolivia_to_world')
  @IsUUID()
  external_account_id?: string;

  @ApiPropertyOptional({ example: 'usdc' })
  @ValidateIf((o) =>
    [
      'bolivia_to_world',
      'wallet_to_wallet',
      'bolivia_to_wallet',
    ].includes(o.flow_type),
  )
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsString()
  @IsIn(
    [
      ...ALLOWED_CRYPTO_CURRENCIES,
      ...['usd', 'eur', 'mxn', 'brl', 'gbp', 'cop'],
    ],
    { message: 'Moneda de destino no soportada' },
  )
  @IsOptional()
  destination_currency?: string;

  // ── wallet_to_wallet: dirección de origen como referencia interna (opcional) ──
  // Bridge ya no la requiere: la transfer usa allow_any_from_address = true.
  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'wallet_to_wallet')
  @IsOptional()
  @IsString()
  source_address?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'wallet_to_wallet')
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn([...ALLOWED_NETWORKS], {
    message: `Red de origen no soportada. Redes permitidas: ${ALLOWED_NETWORKS.join(', ')}`,
  })
  source_network?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'wallet_to_wallet')
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn([...ALLOWED_CRYPTO_CURRENCIES], {
    message: `Moneda de origen no soportada. Monedas permitidas: ${ALLOWED_CRYPTO_CURRENCIES.join(', ')}`,
  })
  source_currency?: string;

  // ── destino crypto (bolivia_to_wallet) — wallet_to_wallet lo resuelve desde el supplier ──
  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'bolivia_to_wallet')
  @IsString()
  @IsNotEmpty()
  destination_address?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'bolivia_to_wallet')
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn([...ALLOWED_NETWORKS], {
    message: `Red de destino no soportada. Redes permitidas: ${ALLOWED_NETWORKS.join(', ')}`,
  })
  destination_network?: string;

  // ── world_to_bolivia: destino es cuenta boliviana ──
  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'world_to_bolivia')
  @IsString()
  @IsNotEmpty()
  destination_bank_name?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'world_to_bolivia')
  @IsString()
  @IsNotEmpty()
  destination_account_number?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'world_to_bolivia')
  @IsString()
  @IsNotEmpty()
  destination_account_holder?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  destination_qr_url?: string;

  // ── world_to_wallet: VA existente ──
  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'world_to_wallet')
  @IsOptional()
  @IsUUID()
  virtual_account_id?: string;

  // ── Campos comunes ──
  @ApiPropertyOptional({
    description: 'ID del proveedor seleccionado por el usuario',
  })
  @ValidateIf((o) =>
    ['bolivia_to_world', 'bolivia_to_wallet', 'wallet_to_wallet'].includes(
      o.flow_type,
    ),
  )
  @IsNotEmpty({
    message:
      'supplier_id es obligatorio para bolivia_to_world, bolivia_to_wallet y wallet_to_wallet',
  })
  @IsOptional()
  @IsUUID()
  supplier_id?: string;

  @ApiProperty({ example: 'Pago a proveedor — Factura #2026-001' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  business_purpose: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  supporting_document_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  // ── Tipo de cambio congelado en la revisión (Step 4) ──
  // "BOB por 1 USD" (effective_rate del par correspondiente). Es lo que el cliente
  // aceptó visualmente; si llega, prevalece sobre el getRate() del servidor.
  @ApiPropertyOptional({
    description:
      'Tipo de cambio congelado en la revisión del cliente (BOB por 1 USD).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  exchange_rate_applied?: number;
}

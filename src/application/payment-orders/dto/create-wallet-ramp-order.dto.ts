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
import { IsBlockchainAddressForNetwork } from '../../bridge/validators/is-blockchain-address.validator';

/** Redes on-chain válidas para el flujo wallet_to_fiat */
export const WALLET_TO_FIAT_ALLOWED_NETWORKS = [
  'ethereum',
  'solana',
  'tron',
  'polygon',
  'stellar',
] as const;

export enum WalletRampFlowType {
  FIAT_BO_TO_BRIDGE_WALLET = 'fiat_bo_to_bridge_wallet',
  CRYPTO_TO_BRIDGE_WALLET = 'crypto_to_bridge_wallet',
  BRIDGE_WALLET_TO_FIAT_BO = 'bridge_wallet_to_fiat_bo',
  BRIDGE_WALLET_TO_CRYPTO = 'bridge_wallet_to_crypto',
  BRIDGE_WALLET_TO_FIAT_US = 'bridge_wallet_to_fiat_us',
  WALLET_TO_FIAT = 'wallet_to_fiat',
}

export class CreateWalletRampOrderDto {
  @ApiProperty({ enum: WalletRampFlowType })
  @IsEnum(WalletRampFlowType)
  flow_type: WalletRampFlowType;

  @ApiProperty({ example: 500.0 })
  @IsNumber()
  @ValidateIf((o) => o.flow_type !== WalletRampFlowType.CRYPTO_TO_BRIDGE_WALLET)
  @Min(0.01)
  amount: number;

  // ── wallet_id: requerido para todos los flujos rampa ──
  @ApiPropertyOptional()
  @IsUUID()
  wallet_id?: string;

  // ── destino crypto (bridge_wallet_to_crypto) ──
  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'bridge_wallet_to_crypto')
  @IsNotEmpty()
  @IsBlockchainAddressForNetwork('destination_network')
  destination_address?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'bridge_wallet_to_crypto')
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn([...ALLOWED_NETWORKS], {
    message: `Red de destino no soportada. Redes permitidas: ${ALLOWED_NETWORKS.join(', ')}`,
  })
  destination_network?: string;

  @ApiPropertyOptional({
    description:
      'Token de destino para on-ramp y off-ramp crypto (ej: usdc, usdt, usdb, pyusd, eurc)',
  })
  @ValidateIf((o) =>
    [
      'bridge_wallet_to_crypto',
      'fiat_bo_to_bridge_wallet',
      'crypto_to_bridge_wallet',
    ].includes(o.flow_type),
  )
  @IsString()
  @IsNotEmpty({
    message: 'Debe especificar la moneda de destino (destination_currency)',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn([...ALLOWED_CRYPTO_CURRENCIES], {
    message: `Moneda de destino no soportada. Monedas permitidas: ${ALLOWED_CRYPTO_CURRENCIES.join(', ')}`,
  })
  destination_currency?: string;

  // ── destino fiat BO (bridge_wallet_to_fiat_bo) ──
  // NOTA: Estos campos ahora se leen desde client_bank_accounts en el backend.
  // Se mantienen opcionales por retrocompatibilidad pero son IGNORADOS en el servicio.
  @ApiPropertyOptional({
    description:
      'Deprecado para fiat_bo. El backend lee de client_bank_accounts.',
  })
  @IsOptional()
  @IsString()
  destination_bank_name?: string;

  @ApiPropertyOptional({
    description:
      'Deprecado para fiat_bo. El backend lee de client_bank_accounts.',
  })
  @IsOptional()
  @IsString()
  destination_account_number?: string;

  @ApiPropertyOptional({
    description:
      'Deprecado para fiat_bo. El backend lee de client_bank_accounts.',
  })
  @IsOptional()
  @IsString()
  destination_account_holder?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  destination_qr_url?: string;

  // ── destino fiat US (bridge_wallet_to_fiat_us) — se resuelve vía supplier ──

  // ── crypto_to_bridge_wallet: origen crypto ──
  @ApiPropertyOptional()
  @ValidateIf((o) =>
    ['crypto_to_bridge_wallet', 'wallet_to_fiat'].includes(o.flow_type),
  )
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn([...ALLOWED_NETWORKS, ...WALLET_TO_FIAT_ALLOWED_NETWORKS], {
    message: `Red de origen no soportada. Redes permitidas: ${[...ALLOWED_NETWORKS, ...WALLET_TO_FIAT_ALLOWED_NETWORKS].join(', ')}`,
  })
  source_network?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.flow_type === 'wallet_to_fiat')
  @IsString()
  @IsNotEmpty()
  source_address?: string;

  // ── Moneda origen explícita (todos los flujos ramp con wallet) ──
  @ApiPropertyOptional({
    description:
      'Token del que se retiran/depositan fondos de la wallet (ej: usdc, usdt)',
  })
  @ValidateIf((o) =>
    [
      'bridge_wallet_to_crypto',
      'bridge_wallet_to_fiat_bo',
      'bridge_wallet_to_fiat_us',
      'crypto_to_bridge_wallet',
      'wallet_to_fiat',
    ].includes(o.flow_type),
  )
  @IsString()
  @IsNotEmpty({
    message: 'Debe especificar la moneda de origen (source_currency)',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsIn([...ALLOWED_CRYPTO_CURRENCIES], {
    message: `Moneda de origen no soportada. Monedas permitidas: ${ALLOWED_CRYPTO_CURRENCIES.join(', ')}`,
  })
  source_currency?: string;

  // ── wallet_to_fiat / bridge_wallet_to_fiat_us / bridge_wallet_to_crypto: proveedor destino ──
  @ApiPropertyOptional({
    description:
      'UUID del proveedor (supplier) destino. Requerido para wallet_to_fiat, bridge_wallet_to_fiat_us y bridge_wallet_to_crypto.',
  })
  @ValidateIf((o) =>
    [
      'wallet_to_fiat',
      'bridge_wallet_to_fiat_us',
      'bridge_wallet_to_crypto',
    ].includes(o.flow_type),
  )
  @IsNotEmpty({ message: 'supplier_id es obligatorio para wallet_to_fiat, bridge_wallet_to_fiat_us y bridge_wallet_to_crypto' })
  @IsUUID()
  supplier_id?: string;

  // ── Campos comunes ──
  @ApiPropertyOptional()
  @ValidateIf((o) =>
    [
      'bridge_wallet_to_fiat_bo',
      'bridge_wallet_to_crypto',
      'bridge_wallet_to_fiat_us',
      'wallet_to_fiat',
      'fiat_bo_to_bridge_wallet',
      'crypto_to_bridge_wallet',
    ].includes(o.flow_type),
  )
  @IsNotEmpty({
    message: 'El motivo de la operación es obligatorio',
  })
  @IsString()
  @MaxLength(500)
  business_purpose?: string;

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

  // ── Solicitud de revisión por exceso de límite ──
  // Presente solo cuando el monto supera el límite máximo y el cliente envía justificación.
  @ApiPropertyOptional({
    description:
      'Motivo que justifica superar el límite máximo. Activa el flujo de revisión manual.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  client_reason?: string;
}

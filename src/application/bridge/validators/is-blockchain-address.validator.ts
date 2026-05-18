import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Mapeo de red Bridge → familia de dirección esperada */
const NETWORK_TO_ADDRESS_FAMILY: Record<string, string> = {
  ethereum: 'evm',
  polygon: 'evm',
  base: 'evm',
  arbitrum: 'evm',
  optimism: 'evm',
  avalanche: 'evm',
  bsc: 'evm',
  solana: 'solana',
  tron: 'tron',
  stellar: 'stellar',
  bitcoin: 'bitcoin',
};

const ADDRESS_PATTERN_BY_FAMILY: Record<string, RegExp> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  stellar: /^G[A-Z2-7]{55}$/,
  bitcoin: /^(1|3)[1-9A-HJ-NP-Za-km-z]{25,34}$|^bc1[0-9a-z]{39,59}$/,
};

/** Valida que una dirección tenga formato válido para cualquier red soportada */
function isValidForAnyNetwork(address: string): boolean {
  return Object.values(ADDRESS_PATTERN_BY_FAMILY).some((p) => p.test(address));
}

/** Valida que una dirección corresponda exactamente a la red indicada */
function isValidForNetwork(address: string, network: string): boolean {
  const family = NETWORK_TO_ADDRESS_FAMILY[network.toLowerCase()];
  if (!family) return isValidForAnyNetwork(address);
  const pattern = ADDRESS_PATTERN_BY_FAMILY[family];
  return pattern ? pattern.test(address) : false;
}

// ─── Validador genérico (sin red) ────────────────────────────────────────────

@ValidatorConstraint({ async: false })
export class IsBlockchainAddressConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    return isValidForAnyNetwork(value);
  }

  defaultMessage(): string {
    return 'La dirección de wallet no tiene un formato válido para ninguna red soportada (EVM, Solana, Tron, Stellar, Bitcoin).';
  }
}

export function IsBlockchainAddress(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsBlockchainAddressConstraint,
    });
  };
}

// ─── Validador con conciencia de red ─────────────────────────────────────────

@ValidatorConstraint({ async: false })
export class IsBlockchainAddressForNetworkConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== 'string') return false;
    const [networkField] = args.constraints as [string];
    const network: unknown = (args.object as Record<string, unknown>)[
      networkField
    ];
    if (typeof network !== 'string' || !network) {
      return isValidForAnyNetwork(value);
    }
    return isValidForNetwork(value, network);
  }

  defaultMessage(args: ValidationArguments): string {
    const [networkField] = args.constraints as [string];
    const network = (args.object as Record<string, unknown>)[networkField];
    return typeof network === 'string' && network
      ? `La dirección no es válida para la red '${network}'. Verifica el formato (EVM: 0x…, Solana: base58, Tron: T…, Stellar: G…).`
      : 'La dirección de wallet no tiene un formato válido para ninguna red soportada.';
  }
}

/**
 * Valida que la dirección corresponda al formato esperado para la red
 * indicada en otro campo del mismo DTO.
 *
 * Uso:
 * ```typescript
 * @IsBlockchainAddressForNetwork('destination_network')
 * destination_address?: string;
 * ```
 */
export function IsBlockchainAddressForNetwork(
  networkField: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [networkField],
      validator: IsBlockchainAddressForNetworkConstraint,
    });
  };
}

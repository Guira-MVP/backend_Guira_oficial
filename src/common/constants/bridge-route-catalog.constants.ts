// ═══════════════════════════════════════════════════════════════════
//  CATÁLOGO DE RUTAS SOPORTADAS POR BRIDGE — ETAPA 1
//  Fuente: lista.md (documentación Bridge, filtrada a destino Solana)
//
//  Estructura: { [red_origen]: { [moneda_origen]: { destinations, min } } }
//
//  Reglas aplicadas:
//  - Solo destino Solana (wallet custodial actual)
//  - Solo tokens destino en ALLOWED_CRYPTO_CURRENCIES
//  - Solo tokens origen en ALLOWED_CRYPTO_CURRENCIES
//
//  El frontend tiene su réplica en:
//  m-guira/features/payments/lib/bridge-route-catalog.ts
// ═══════════════════════════════════════════════════════════════════

export interface BridgeRouteEntry {
  destinations: string[];
  min: number;
}

/**
 * Catálogo de rutas soportadas para on-ramp crypto_to_bridge_wallet.
 * Cada key es una red de origen; sub-keys son monedas de origen.
 */
export const BRIDGE_RAMP_ON_ROUTES: Record<
  string,
  Record<string, BridgeRouteEntry>
> = {
  ethereum: {
    usdc: { destinations: ['usdc', 'usdb', 'pyusd', 'eurc'], min: 1 },
    usdt: { destinations: ['usdc', 'usdt', 'usdb'], min: 2 },
    eurc: { destinations: ['usdc', 'usdb', 'eurc'], min: 1 },
    pyusd: { destinations: ['usdc', 'pyusd'], min: 1 },
  },
  solana: {
    usdc: { destinations: ['usdc', 'usdb', 'pyusd', 'eurc'], min: 1 },
    usdt: { destinations: ['usdc', 'usdb'], min: 2 },
    usdb: { destinations: ['pyusd', 'usdt'], min: 1 },
    eurc: { destinations: ['usdc', 'usdb', 'eurc'], min: 1 },
    pyusd: { destinations: ['usdc', 'usdt'], min: 1 },
  },
  tron: {
    usdt: { destinations: ['usdc', 'usdt', 'usdb', 'pyusd'], min: 5 },
  },
  polygon: {
    usdc: {
      destinations: ['usdc', 'usdt', 'usdb', 'pyusd', 'eurc'],
      min: 1,
    },
  },
  stellar: {
    usdc: {
      destinations: ['usdc', 'usdt', 'usdb', 'pyusd', 'eurc'],
      min: 1,
    },
  },
};

/**
 * Tokens destino permitidos para fiat_bo_to_bridge_wallet.
 * Cada token destino tiene su red origen directa (ver resolvePsavCryptoSource).
 */
export const FIAT_BO_ALLOWED_DESTINATION_CURRENCIES = [
  'usdc',
  'usdt',
  'usdb',
  'pyusd',
  'eurc',
] as const;

/**
 * Tokens de origen excluidos para fiat_bo_to_bridge_wallet.
 * Con el nuevo flujo Etapa 2 todas las divisas tienen fuente directa:
 * USDC/USDT/PYUSD/EURC → Ethereum, USDB → Tempo.
 * No hay exclusiones vigentes.
 */
export const FIAT_BO_EXCLUDED_SOURCE_CURRENCIES: readonly string[] = [];

/**
 * Resuelve la red y moneda de origen del PSAV para fiat_bo_to_bridge_wallet.
 * Cada divisa destino tiene red origen propia:
 *
 * usdb          → tempo/usdb
 * usdc          → solana/usdc
 * eurc          → solana/eurc
 * resto         → ethereum/{misma moneda}  (usdt, pyusd)
 */
export function resolvePsavCryptoSource(destCurrency: string): {
  payment_rail: string;
  currency: string;
} {
  const dest = destCurrency.toLowerCase();
  if (dest === 'usdb') {
    return { payment_rail: 'tempo', currency: 'usdb' };
  }
  if (dest === 'usdc' || dest === 'eurc') {
    return { payment_rail: 'solana', currency: dest };
  }
  return { payment_rail: 'ethereum', currency: dest };
}

/** Dado una red, retorna las monedas de origen válidas */
export function getSourceCurrencies(network: string): string[] {
  return Object.keys(BRIDGE_RAMP_ON_ROUTES[network] ?? {});
}

/** Dado una red + moneda origen, retorna las monedas destino válidas */
export function getDestinationCurrencies(
  network: string,
  sourceCurrency: string,
): string[] {
  return (
    BRIDGE_RAMP_ON_ROUTES[network]?.[sourceCurrency.toLowerCase()]
      ?.destinations ?? []
  );
}

/** Dado una red + moneda origen, retorna el mínimo de transacción */
export function getMinAmount(network: string, sourceCurrency: string): number {
  return (
    BRIDGE_RAMP_ON_ROUTES[network]?.[sourceCurrency.toLowerCase()]?.min ?? 1
  );
}

/** Valida si una combinación red/origen/destino es soportada por Bridge */
export function isValidBridgeRampRoute(
  sourceNetwork: string,
  sourceCurrency: string,
  destinationCurrency: string,
): boolean {
  const route =
    BRIDGE_RAMP_ON_ROUTES[sourceNetwork]?.[sourceCurrency.toLowerCase()];
  if (!route) return false;
  return route.destinations.includes(destinationCurrency.toLowerCase());
}

/** Valida si un token es válido como destino para fiat_bo_to_bridge_wallet */
export function isValidFiatBoDestination(currency: string): boolean {
  return (FIAT_BO_ALLOWED_DESTINATION_CURRENCIES as readonly string[]).includes(
    currency.toLowerCase(),
  );
}

// ═══════════════════════════════════════════════════════════════════
//  RUTAS ON-RAMP INDEXADAS POR DESTINO — crypto_to_bridge_wallet
//  Fuente: lista_permitida_moneda_origen_destino.md
//
//  Estructura: { [dest_currency]: [{ network, currency, min }, ...] }
//
//  Uso: valida qué combinaciones de origen son permitidas dado
//  el token destino ya seleccionado por el usuario.
// ═══════════════════════════════════════════════════════════════════

export interface AllowedSourceEntry {
  network: string;
  currency: string;
  min: number;
}

/**
 * Combinaciones de origen permitidas por token de destino.
 * Destino siempre Solana (wallet custodial).
 */
export const BRIDGE_ON_RAMP_ALLOWED_SOURCES_BY_DEST: Record<
  string,
  AllowedSourceEntry[]
> = {
  usdc: [
    { network: 'ethereum', currency: 'usdc', min: 1 },
    { network: 'polygon',  currency: 'usdc', min: 1 },
    { network: 'solana',   currency: 'usdc', min: 1 },
    { network: 'stellar',  currency: 'usdc', min: 1 },
  ],
  usdt: [
    { network: 'ethereum', currency: 'usdt', min: 20 },
    { network: 'tron',     currency: 'usdt', min: 20 },
  ],
  usdb: [],
  pyusd: [
    { network: 'ethereum', currency: 'pyusd', min: 1 },
  ],
  eurc: [
    { network: 'ethereum', currency: 'eurc', min: 1 },
    { network: 'solana',   currency: 'eurc', min: 1 },
  ],
};

/** Dado un token destino, retorna las redes de origen disponibles (sin duplicados) */
export function getSourceNetworksForDest(destCurrency: string): string[] {
  const sources =
    BRIDGE_ON_RAMP_ALLOWED_SOURCES_BY_DEST[destCurrency.toLowerCase()] ?? [];
  return [...new Set(sources.map((s) => s.network))];
}

/** Dado un token destino + red de origen, retorna las monedas de origen disponibles */
export function getSourceCurrenciesForDestAndNetwork(
  destCurrency: string,
  sourceNetwork: string,
): string[] {
  const sources =
    BRIDGE_ON_RAMP_ALLOWED_SOURCES_BY_DEST[destCurrency.toLowerCase()] ?? [];
  return sources
    .filter((s) => s.network === sourceNetwork.toLowerCase())
    .map((s) => s.currency);
}

/** Mínimo de transacción dado el token destino, red de origen y moneda de origen */
export function getMinAmountByDest(
  destCurrency: string,
  sourceNetwork: string,
  sourceCurrency: string,
): number {
  const sources =
    BRIDGE_ON_RAMP_ALLOWED_SOURCES_BY_DEST[destCurrency.toLowerCase()] ?? [];
  const match = sources.find(
    (s) =>
      s.network === sourceNetwork.toLowerCase() &&
      s.currency === sourceCurrency.toLowerCase(),
  );
  return match?.min ?? 1;
}

/** Valida si una combinación origen→destino es permitida según el documento */
export function isValidOnRampSourceForDest(
  destCurrency: string,
  sourceNetwork: string,
  sourceCurrency: string,
): boolean {
  const sources =
    BRIDGE_ON_RAMP_ALLOWED_SOURCES_BY_DEST[destCurrency.toLowerCase()] ?? [];
  return sources.some(
    (s) =>
      s.network === sourceNetwork.toLowerCase() &&
      s.currency === sourceCurrency.toLowerCase(),
  );
}

// ═══════════════════════════════════════════════════════════════════
//  CATÁLOGO DE RUTAS OFF-RAMP (bridge_wallet_to_crypto)
//  Fuente: lista_bridge_out.md (filtrada a tokens soportados)
//
//  Estructura: { [source_currency]: { [dest_network]: { [dest_currency]: min_amount } } }
//
//  Reglas aplicadas:
//  - Source rail siempre Solana (wallet custodial)
//  - DAI y USDG excluidos (no en ALLOWED_CRYPTO_CURRENCIES)
//  - Red Base excluida (sin rutas soportadas desde Solana)
//
//  El frontend tiene su réplica en:
//  m-guira/features/payments/lib/bridge-route-catalog.ts
// ═══════════════════════════════════════════════════════════════════

/**
 * Catálogo de rutas soportadas para off-ramp bridge_wallet_to_crypto.
 * Solo rutas same-token (source_currency == destination_currency).
 * Fuente: documentación Bridge — lista_filtrada_misma_moneda.md
 * { [source_currency]: { [dest_network]: { [dest_currency]: min_amount } } }
 */
export const BRIDGE_RAMP_OFF_ROUTES: Record<
  string,
  Record<string, Record<string, number>>
> = {
  // Source: bridge_wallet (Solana). Same-token only.
  usdc: {
    ethereum: { usdc: 1 },
    solana:   { usdc: 1 },
    polygon:  { usdc: 1 },
    stellar:  { usdc: 1 },
  },
  usdt: {
    ethereum: { usdt: 20 },
    solana:   { usdt: 5 },
    tron:     { usdt: 5 },
  },
  usdb: {
    solana: { usdb: 1 },
  },
  pyusd: {
    ethereum: { pyusd: 1 },
  },
  eurc: {
    ethereum: { eurc: 1 },
    solana:   { eurc: 1 },
    stellar:  { eurc: 1 },
  },
};

/** Valida si una combinación off-ramp es soportada por Bridge */
export function isValidOffRampRoute(
  sourceCurrency: string,
  destNetwork: string,
  destCurrency: string,
): boolean {
  return (
    (BRIDGE_RAMP_OFF_ROUTES[sourceCurrency.toLowerCase()]?.[
      destNetwork.toLowerCase()
    ]?.[destCurrency.toLowerCase()] ?? 0) > 0
  );
}

/** Monto mínimo para una ruta off-ramp completa */
export function getOffRampMinAmount(
  sourceCurrency: string,
  destNetwork: string,
  destCurrency: string,
): number {
  return (
    BRIDGE_RAMP_OFF_ROUTES[sourceCurrency.toLowerCase()]?.[
      destNetwork.toLowerCase()
    ]?.[destCurrency.toLowerCase()] ?? 0
  );
}

// ═══════════════════════════════════════════════════════════════════
//  CATÁLOGO FIAT_BO OFF-RAMP (bridge_wallet_to_fiat_bo)
//  Match estricto mismo token: el token origen en Bridge wallet debe
//  coincidir exactamente con la divisa de la cuenta PSAV crypto.
//
//  Estructura: { [source_currency]: { [psav_network]: { [psav_currency]: min_amount } } }
//
//  Reglas:
//  - USDC en Bridge wallet → PSAV USDC (Solana)
//  - USDT en Bridge wallet → PSAV USDT (Solana)
//  - Sin match → operación bloqueada con mensaje al usuario
// ═══════════════════════════════════════════════════════════════════

/**
 * Rutas off-ramp válidas para bridge_wallet_to_fiat_bo.
 * Match estricto: source_currency debe igualar la divisa de la cuenta PSAV.
 * { [source_currency]: { [psav_network]: { [psav_currency]: min_amount } } }
 */
export const FIAT_BO_OFF_RAMP_ROUTES: Record<
  string,
  Record<string, Record<string, number>>
> = {
  usdc: { solana: { usdc: 1 } },
  usdt: { tron:   { usdt: 5 } },
};

/** Tokens de origen válidos para fiat_bo off-ramp */
export const FIAT_BO_OFF_RAMP_SOURCE_CURRENCIES = Object.keys(
  FIAT_BO_OFF_RAMP_ROUTES,
);

/**
 * Verifica si un token de origen tiene al menos una ruta válida
 * hacia algún PSAV en una red dada.
 */
export function isFiatBoOffRampSourceValid(
  sourceCurrency: string,
  psavNetwork: string,
  psavCurrency: string,
): boolean {
  return (
    (FIAT_BO_OFF_RAMP_ROUTES[sourceCurrency.toLowerCase()]?.[
      psavNetwork.toLowerCase()
    ]?.[psavCurrency.toLowerCase()] ?? 0) > 0
  );
}

/** Monto mínimo para una ruta fiat_bo off-ramp */
export function getFiatBoOffRampMinAmount(
  sourceCurrency: string,
  psavNetwork: string,
  psavCurrency: string,
): number {
  return (
    FIAT_BO_OFF_RAMP_ROUTES[sourceCurrency.toLowerCase()]?.[
      psavNetwork.toLowerCase()
    ]?.[psavCurrency.toLowerCase()] ?? 0
  );
}

/**
 * Dado un token de origen y una lista de cuentas PSAV activas,
 * resuelve la cuenta PSAV con divisa idéntica al token origen.
 *
 * Match estricto: USDT→PSAV USDT, USDC→PSAV USDC.
 * No hay fallback cruzado — si no existe cuenta PSAV con esa divisa, retorna null.
 *
 * @returns { psavAccount, destCurrency, minAmount } o null si no hay ruta
 */
export function resolveFiatBoPsavMatch<
  T extends { currency: string; crypto_network: string },
>(
  sourceCurrency: string,
  psavAccounts: T[],
): { psavAccount: T; destCurrency: string; minAmount: number } | null {
  const srcLower = sourceCurrency.toLowerCase();
  const routes = FIAT_BO_OFF_RAMP_ROUTES[srcLower];
  if (!routes) return null;

  // Buscar cuenta PSAV con exactamente la misma divisa que el token origen
  const psav = psavAccounts.find(
    (a) => a.currency.toLowerCase() === srcLower,
  );
  if (!psav) return null;

  const psavNetwork = (psav.crypto_network ?? '').toLowerCase();
  const minAmount = routes[psavNetwork]?.[srcLower] ?? 0;
  if (minAmount === 0) return null;

  return {
    psavAccount: psav,
    destCurrency: psav.currency,
    minAmount,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  CATÁLOGO DE RUTAS TRANSFER WALLET-TO-WALLET — ETAPA 2
//  Fuente: lista_w_t_w.md (Bridge API Transfer)
//
//  Estructura de consulta:
//  Dado un (dest_network, dest_currency) → lista de sources válidos
//  con su monto mínimo de transacción.
//
//  Notas:
//  - Todas las redes en lowercase para normalización.
//  - Monedas en lowercase para normalización.
//  - Solo rutas same-currency: USDC→USDC y USDT→USDT.
//  - No se permiten conversiones cruzadas entre monedas.
//
//  El frontend tiene su réplica en:
//  m-guira/features/payments/lib/transfer-route-catalog.ts
// ═══════════════════════════════════════════════════════════════════

export interface TransferSourceRoute {
  source_network: string;
  source_currency: string;
  min: number;
}

/**
 * Catálogo de rutas soportadas para wallet_to_wallet (Bridge Transfer API).
 * Indexado por { dest_network }->{ dest_currency }->[ sources ].
 *
 * Transcripción completa de lista_w_t_w.md.
 * Solo rutas same-currency: USDC→USDC y USDT→USDT.
 */
export const TRANSFER_ROUTE_CATALOG: Record<
  string, // dest_network
  Record<
    string, // dest_currency
    TransferSourceRoute[]
  >
> = {
  // ─── Destino: Solana / USDC ──────────────────────────────────────
  solana: {
    usdc: [
      { source_network: 'solana', source_currency: 'usdc', min: 1 },
      { source_network: 'ethereum', source_currency: 'usdc', min: 1 },
      { source_network: 'polygon', source_currency: 'usdc', min: 1 },
      { source_network: 'stellar', source_currency: 'usdc', min: 1 },
    ],
  },

  // ─── Destino: Ethereum / USDC ────────────────────────────────────
  ethereum: {
    usdc: [
      { source_network: 'solana', source_currency: 'usdc', min: 1 },
      { source_network: 'polygon', source_currency: 'usdc', min: 1 },
      { source_network: 'stellar', source_currency: 'usdc', min: 1 },
    ],
  },

  // ─── Destino: Polygon / USDC ─────────────────────────────────────
  polygon: {
    usdc: [
      { source_network: 'solana', source_currency: 'usdc', min: 1 },
      { source_network: 'ethereum', source_currency: 'usdc', min: 1 },
      { source_network: 'stellar', source_currency: 'usdc', min: 1 },
    ],
  },

  // ─── Destino: Stellar / USDC ─────────────────────────────────────
  stellar: {
    usdc: [
      { source_network: 'solana', source_currency: 'usdc', min: 1 },
      { source_network: 'ethereum', source_currency: 'usdc', min: 1 },
      { source_network: 'polygon', source_currency: 'usdc', min: 1 },
      { source_network: 'stellar', source_currency: 'usdc', min: 1 },
    ],
  },

  // ─── Destino: Tron / USDT ────────────────────────────────────────
  tron: {
    usdt: [
      { source_network: 'solana', source_currency: 'usdt', min: 5 },
      { source_network: 'ethereum', source_currency: 'usdt', min: 5 },
      { source_network: 'tron', source_currency: 'usdt', min: 5 },
    ],
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Dado un destino (red + moneda), retorna las fuentes válidas con sus mínimos.
 * Retorna array vacío si el destino no tiene rutas soportadas.
 */
export function getValidSourceRoutes(
  destNetwork: string,
  destCurrency: string,
): TransferSourceRoute[] {
  return (
    TRANSFER_ROUTE_CATALOG[destNetwork.toLowerCase()]?.[
      destCurrency.toLowerCase()
    ] ?? []
  );
}

/**
 * Valida si una combinación completa (src_net, src_cur, dst_net, dst_cur)
 * es soportada por Bridge Transfer API.
 */
export function isValidTransferRoute(
  srcNetwork: string,
  srcCurrency: string,
  dstNetwork: string,
  dstCurrency: string,
): boolean {
  const sources = getValidSourceRoutes(dstNetwork, dstCurrency);
  return sources.some(
    (s) =>
      s.source_network === srcNetwork.toLowerCase() &&
      s.source_currency === srcCurrency.toLowerCase(),
  );
}

/**
 * Retorna el monto mínimo para una ruta transfer dada.
 * Retorna 0 si la ruta no existe.
 */
export function getTransferMinAmount(
  srcNetwork: string,
  srcCurrency: string,
  dstNetwork: string,
  dstCurrency: string,
): number {
  const sources = getValidSourceRoutes(dstNetwork, dstCurrency);
  const route = sources.find(
    (s) =>
      s.source_network === srcNetwork.toLowerCase() &&
      s.source_currency === srcCurrency.toLowerCase(),
  );
  return route?.min ?? 0;
}

/**
 * Retorna las redes de origen únicas disponibles dado un destino.
 */
export function getAvailableSourceNetworks(
  dstNetwork: string,
  dstCurrency: string,
): string[] {
  const sources = getValidSourceRoutes(dstNetwork, dstCurrency);
  return [...new Set(sources.map((s) => s.source_network))];
}

/**
 * Dado un destino y una red de origen, retorna las monedas de origen válidas.
 */
export function getAvailableSourceCurrencies(
  dstNetwork: string,
  dstCurrency: string,
  srcNetwork: string,
): string[] {
  const sources = getValidSourceRoutes(dstNetwork, dstCurrency);
  return sources
    .filter((s) => s.source_network === srcNetwork.toLowerCase())
    .map((s) => s.source_currency);
}

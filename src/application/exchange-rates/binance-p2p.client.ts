import { Injectable, BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_BINANCE_P2P_URL =
  'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 500;

type BinanceTradeType = 'BUY' | 'SELL';

interface BinanceAdvSearchResponse {
  data?: Array<{ adv: { price: string } }>;
}

/**
 * Cliente para el endpoint público (no oficial) de anuncios P2P de Binance.
 * Se usa como fuente del tipo de cambio paralelo BOB/USD, en reemplazo del
 * proxy de terceros (api-mdp-2.onrender.com) que dejó de responder.
 */
@Injectable()
export class BinanceP2pClient {
  private readonly logger = new Logger(BinanceP2pClient.name);
  private readonly apiUrl: string;

  constructor(private readonly config: ConfigService) {
    this.apiUrl =
      this.config.get<string>('app.binanceP2pApiUrl') ??
      DEFAULT_BINANCE_P2P_URL;
  }

  /**
   * Trae los precios de los `rows` mejores anuncios USDT/BOB para el lado
   * pedido. Binance ya los devuelve ordenados por mejor precio (no se
   * reordenan acá).
   */
  async fetchTopAds(tradeType: BinanceTradeType, rows = 10): Promise<number[]> {
    const body = JSON.stringify({
      asset: 'USDT',
      fiat: 'BOB',
      tradeType,
      page: 1,
      rows,
      payTypes: [],
      publisherType: null,
    });

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
      try {
        return await this.requestOnce(body);
      } catch (e) {
        lastError = e;
        this.logger.warn(
          `Intento ${attempt + 1}/2 fallido para Binance P2P (${tradeType}): ${(e as Error).message}`,
        );
      }
    }

    this.logger.error(
      `No se pudo obtener anuncios de Binance P2P (${tradeType}) tras reintentos: ${(lastError as Error)?.message}`,
    );
    throw new BadGatewayException(
      'No se pudo obtener el tipo de cambio desde el proveedor de mercado P2P. Inténtalo de nuevo en unos minutos.',
    );
  }

  private async requestOnce(body: string): Promise<number[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const payload = (await res.json()) as BinanceAdvSearchResponse;
      const ads = payload.data ?? [];

      if (ads.length === 0) {
        throw new Error('Binance P2P no devolvió anuncios para USDT/BOB');
      }

      const prices = ads
        .map((item) => parseFloat(item.adv.price))
        .filter((price) => Number.isFinite(price) && price > 0);

      if (prices.length === 0) {
        throw new Error('Binance P2P devolvió anuncios sin precio válido');
      }

      return prices;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Promedio simple de los precios de los `rows` mejores anuncios. */
  async getAveragePrice(
    tradeType: BinanceTradeType,
    rows = 10,
  ): Promise<number> {
    const prices = await this.fetchTopAds(tradeType, rows);
    return prices.reduce((sum, p) => sum + p, 0) / prices.length;
  }
}

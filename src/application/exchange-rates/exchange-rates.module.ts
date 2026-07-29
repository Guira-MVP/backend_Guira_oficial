import { Module } from '@nestjs/common';
import { ExchangeRatesService } from './exchange-rates.service';
import { ExchangeRatesGateway } from './exchange-rates.gateway';
import { BinanceP2pClient } from './binance-p2p.client';
import { BridgeModule } from '../bridge/bridge.module';

@Module({
  imports: [BridgeModule],
  providers: [ExchangeRatesService, ExchangeRatesGateway, BinanceP2pClient],
  exports: [ExchangeRatesService, ExchangeRatesGateway],
})
export class ExchangeRatesModule {}

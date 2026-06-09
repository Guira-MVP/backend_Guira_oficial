import { Module } from '@nestjs/common';
import { ExchangeRatesService } from './exchange-rates.service';
import { ExchangeRatesGateway } from './exchange-rates.gateway';
import { BridgeModule } from '../bridge/bridge.module';

@Module({
  imports: [BridgeModule],
  providers: [ExchangeRatesService, ExchangeRatesGateway],
  exports: [ExchangeRatesService, ExchangeRatesGateway],
})
export class ExchangeRatesModule {}

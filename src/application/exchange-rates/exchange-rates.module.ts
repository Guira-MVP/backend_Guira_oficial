import { Module } from '@nestjs/common';
import { ExchangeRatesService } from './exchange-rates.service';
import { ExchangeRatesGateway } from './exchange-rates.gateway';

@Module({
  providers: [ExchangeRatesService, ExchangeRatesGateway],
  exports: [ExchangeRatesService, ExchangeRatesGateway],
})
export class ExchangeRatesModule {}

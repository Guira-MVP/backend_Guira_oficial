import { Module } from '@nestjs/common';
import {
  PaymentOrdersController,
  AdminPaymentOrdersController,
} from './payment-orders.controller';
import { PaymentOrdersService } from './payment-orders.service';
import { OrderReviewService } from './order-review.service';
import { FeesModule } from '../fees/fees.module';
import { PsavModule } from '../psav/psav.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { BridgeModule } from '../bridge/bridge.module';
import { ClientBankAccountsModule } from '../client-bank-accounts/client-bank-accounts.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { ExportModule } from '../../core/export/export.module';
import { ProfilesModule } from '../profiles/profiles.module';
import { WalletsModule } from '../wallets/wallets.module';

@Module({
  imports: [
    FeesModule,
    PsavModule,
    ExchangeRatesModule,
    BridgeModule,
    ClientBankAccountsModule,
    SuppliersModule,
    ExportModule,
    ProfilesModule,
    WalletsModule,
  ],
  controllers: [PaymentOrdersController, AdminPaymentOrdersController],
  providers: [PaymentOrdersService, OrderReviewService],
  exports: [PaymentOrdersService, OrderReviewService],
})
export class PaymentOrdersModule {}


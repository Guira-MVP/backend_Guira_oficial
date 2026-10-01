import { Module, forwardRef } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { BridgeModule } from '../bridge/bridge.module';
import { WalletsModule } from '../wallets/wallets.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { OrdersModule } from '../orders/orders.module';
import { AdminModule } from '../admin/admin.module';
import { PaymentOrdersModule } from '../payment-orders/payment-orders.module';
import { ProvidersModule } from '../onboarding/providers/providers.module';

@Module({
  imports: [
    BridgeModule,
    WalletsModule,
    forwardRef(() => ComplianceModule),
    PaymentOrdersModule,
    OrdersModule,
    AdminModule,
    ProvidersModule,
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}

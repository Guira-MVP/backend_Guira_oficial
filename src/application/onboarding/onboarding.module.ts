import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { BridgeCustomerService } from './bridge-customer.service';
import { BridgeModule } from '../bridge/bridge.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [BridgeModule, OrdersModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, BridgeCustomerService],
  exports: [OnboardingService, BridgeCustomerService],
})
export class OnboardingModule {}

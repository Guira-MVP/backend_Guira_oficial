import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingDraftService } from './onboarding-draft.service';
import { BridgeCustomerService } from './bridge-customer.service';
import { StaffOnboardingAssistController } from './staff-onboarding-assist.controller';
import { StaffOnboardingAssistService } from './staff-onboarding-assist.service';
import { BridgeModule } from '../bridge/bridge.module';
import { OrdersModule } from '../orders/orders.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [BridgeModule, OrdersModule, AdminModule],
  controllers: [OnboardingController, StaffOnboardingAssistController],
  providers: [
    OnboardingService,
    OnboardingDraftService,
    BridgeCustomerService,
    StaffOnboardingAssistService,
  ],
  exports: [OnboardingService, OnboardingDraftService, BridgeCustomerService],
})
export class OnboardingModule {}

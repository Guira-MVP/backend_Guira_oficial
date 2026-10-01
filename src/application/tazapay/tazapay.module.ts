import { Module } from '@nestjs/common';
import { TazapayApiClient } from './tazapay-api.client';
import { TazapayKybOnboardingService } from './onboarding/tazapay-kyb-onboarding.service';

/** Tazapay: segundo proveedor (onboarding KYB/KYC y, después, SWIFT). */
@Module({
  providers: [TazapayApiClient, TazapayKybOnboardingService],
  exports: [TazapayApiClient, TazapayKybOnboardingService],
})
export class TazapayModule {}

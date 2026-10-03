import { Module } from '@nestjs/common';
import { TazapayApiClient } from './tazapay-api.client';
import { TazapayKybOnboardingService } from './onboarding/tazapay-kyb-onboarding.service';
import { TazapayKycOnboardingService } from './onboarding/tazapay-kyc-onboarding.service';
import { TazapayDocumentUploader } from './onboarding/tazapay-document-uploader';

/** Tazapay: segundo proveedor (onboarding KYB/KYC y, después, SWIFT). */
@Module({
  providers: [
    TazapayApiClient,
    TazapayDocumentUploader,
    TazapayKybOnboardingService,
    TazapayKycOnboardingService,
  ],
  exports: [
    TazapayApiClient,
    TazapayKybOnboardingService,
    TazapayKycOnboardingService,
  ],
})
export class TazapayModule {}

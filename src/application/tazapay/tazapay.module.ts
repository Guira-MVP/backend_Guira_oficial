import { Module } from '@nestjs/common';
import { TazapayApiClient } from './tazapay-api.client';
import { TazapayKybOnboardingService } from './onboarding/tazapay-kyb-onboarding.service';
import { TazapayKycOnboardingService } from './onboarding/tazapay-kyc-onboarding.service';
import { TazapayDocumentUploader } from './onboarding/tazapay-document-uploader';
import { TazapaySwiftEligibilityService } from './swift/tazapay-swift-eligibility.service';
import { TazapayCorridorService } from './swift/tazapay-corridor.service';
import { TazapayBeneficiariesService } from './swift/tazapay-beneficiaries.service';
import { TazapaySwiftController } from './swift/tazapay-swift.controller';

/** Tazapay: segundo proveedor (onboarding KYB/KYC y beneficiarios SWIFT). */
@Module({
  controllers: [TazapaySwiftController],
  providers: [
    TazapayApiClient,
    TazapayDocumentUploader,
    TazapayKybOnboardingService,
    TazapayKycOnboardingService,
    TazapaySwiftEligibilityService,
    TazapayCorridorService,
    TazapayBeneficiariesService,
  ],
  exports: [
    TazapayApiClient,
    TazapayKybOnboardingService,
    TazapayKycOnboardingService,
    TazapaySwiftEligibilityService,
    TazapayCorridorService,
    TazapayBeneficiariesService,
  ],
})
export class TazapayModule {}

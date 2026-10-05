import { Module } from '@nestjs/common';
import { TazapayApiClient } from './tazapay-api.client';
import { TazapayKybOnboardingService } from './onboarding/tazapay-kyb-onboarding.service';
import { TazapayKycOnboardingService } from './onboarding/tazapay-kyc-onboarding.service';
import { TazapayDocumentUploader } from './onboarding/tazapay-document-uploader';
import { TazapaySwiftEligibilityService } from './swift/tazapay-swift-eligibility.service';
import { TazapayCorridorService } from './swift/tazapay-corridor.service';
import { TazapayBeneficiariesService } from './swift/tazapay-beneficiaries.service';
import { TazapaySwiftController } from './swift/tazapay-swift.controller';
import { TazapayCollectionAccountService } from './collection/tazapay-collection-account.service';

/** Tazapay: segundo proveedor (onboarding KYB/KYC, beneficiarios SWIFT y wallet de fondeo). */
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
    TazapayCollectionAccountService,
  ],
  exports: [
    TazapayApiClient,
    TazapayKybOnboardingService,
    TazapayKycOnboardingService,
    TazapaySwiftEligibilityService,
    TazapayCorridorService,
    TazapayBeneficiariesService,
    TazapayCollectionAccountService,
  ],
})
export class TazapayModule {}

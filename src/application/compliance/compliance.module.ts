import { Module, forwardRef } from '@nestjs/common';
import {
  ComplianceController,
  AdminComplianceController,
  AdminUserController,
} from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ComplianceActionsService } from './compliance-actions.service';
import { RejectionTemplatesController } from './rejection-templates.controller';
import { RejectionTemplatesService } from './rejection-templates.service';
import { BridgeModule } from '../bridge/bridge.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { PsavModule } from '../psav/psav.module';

@Module({
  imports: [forwardRef(() => BridgeModule), forwardRef(() => OnboardingModule), PsavModule],
  controllers: [
    ComplianceController,
    AdminComplianceController,
    AdminUserController,
    RejectionTemplatesController,
  ],
  providers: [
    ComplianceService,
    ComplianceActionsService,
    RejectionTemplatesService,
  ],
  exports: [ComplianceService, ComplianceActionsService],
})
export class ComplianceModule {}

import { Module } from '@nestjs/common';
import { DiditApiClient } from './didit-api.client';
import { DiditVerificationService } from './didit-verification.service';
import { DiditWalletScreeningService } from './didit-wallet-screening.service';
import { DiditWalletRescreeningService } from './didit-wallet-rescreening.service';

@Module({
  providers: [
    DiditApiClient,
    DiditVerificationService,
    DiditWalletScreeningService,
    DiditWalletRescreeningService,
  ],
  exports: [
    DiditVerificationService,
    DiditWalletScreeningService,
    DiditWalletRescreeningService,
  ],
})
export class DiditModule {}

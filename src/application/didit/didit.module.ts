import { Module } from '@nestjs/common';
import { DiditApiClient } from './didit-api.client';
import { DiditVerificationService } from './didit-verification.service';
import { DiditWalletScreeningService } from './didit-wallet-screening.service';

@Module({
  providers: [
    DiditApiClient,
    DiditVerificationService,
    DiditWalletScreeningService,
  ],
  exports: [DiditVerificationService, DiditWalletScreeningService],
})
export class DiditModule {}

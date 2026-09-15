import { Module } from '@nestjs/common';
import { DiditApiClient } from './didit-api.client';
import { DiditVerificationService } from './didit-verification.service';

@Module({
  providers: [DiditApiClient, DiditVerificationService],
  exports: [DiditVerificationService],
})
export class DiditModule {}

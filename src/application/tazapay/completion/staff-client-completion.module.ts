import { Module } from '@nestjs/common';
import { OnboardingModule } from '../../onboarding/onboarding.module';
import { TazapayModule } from '../tazapay.module';
import { StaffClientCompletionController } from './staff-client-completion.controller';
import { StaffClientCompletionService } from './staff-client-completion.service';

/** Completar datos de clientes ya aprobados para enviarlos a Tazapay. */
@Module({
  imports: [OnboardingModule, TazapayModule],
  controllers: [StaffClientCompletionController],
  providers: [StaffClientCompletionService],
})
export class StaffClientCompletionModule {}

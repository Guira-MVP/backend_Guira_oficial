import { Module } from '@nestjs/common';
import { TazapayModule } from '../../tazapay/tazapay.module';
import { ProviderOnboardingService } from './provider-onboarding.service';
import { ProviderOnboardingController } from './provider-onboarding.controller';

/**
 * Onboarding multiproveedor: registra el envío a Bridge y despacha el de
 * Tazapay. Lo usan Compliance (al aprobar) y Webhooks (estados de Tazapay).
 */
@Module({
  imports: [TazapayModule],
  controllers: [ProviderOnboardingController],
  providers: [ProviderOnboardingService],
  exports: [ProviderOnboardingService, TazapayModule],
})
export class ProvidersModule {}

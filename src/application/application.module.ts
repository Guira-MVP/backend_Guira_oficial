import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ProfilesModule } from './profiles/profiles.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { WalletsModule } from './wallets/wallets.module';
import { LedgerModule } from './ledger/ledger.module';
import { FeesModule } from './fees/fees.module';
import { ComplianceModule } from './compliance/compliance.module';
import { BridgeModule } from './bridge/bridge.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AdminModule } from './admin/admin.module';
import { SupportModule } from './support/support.module';
import { PaymentOrdersModule } from './payment-orders/payment-orders.module';
import { PsavModule } from './psav/psav.module';
import { ExchangeRatesModule } from './exchange-rates/exchange-rates.module';
import { ClientBankAccountsModule } from './client-bank-accounts/client-bank-accounts.module';

/**
 * ApplicationModule agrupa todos los módulos de negocio de Guira.
 * Todos los servicios tienen acceso al SupabaseModule via @Global().
 */
@Module({
  imports: [
    AuthModule,
    ProfilesModule,
    OnboardingModule,
    WalletsModule,
    LedgerModule,
    FeesModule,
    ComplianceModule,
    BridgeModule,
    SuppliersModule,
    WebhooksModule,
    NotificationsModule,
    AdminModule,
    SupportModule,
    PaymentOrdersModule,
    PsavModule,
    ExchangeRatesModule,
    ClientBankAccountsModule,
  ],
})
export class ApplicationModule {}

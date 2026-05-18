import { Module, forwardRef } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { BridgeModule } from '../bridge/bridge.module';
import { WalletsModule } from '../wallets/wallets.module';
import { ComplianceModule } from '../compliance/compliance.module';

@Module({
  imports: [BridgeModule, WalletsModule, forwardRef(() => ComplianceModule)],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}

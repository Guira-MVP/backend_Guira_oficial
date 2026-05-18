import { Module } from '@nestjs/common';
import { BridgeController, AdminBridgeController } from './bridge.controller';
import { BridgeService } from './bridge.service';
import { BridgeApiClient } from './bridge-api.client';
import { FeesModule } from '../fees/fees.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [FeesModule, LedgerModule],
  controllers: [BridgeController, AdminBridgeController],
  providers: [BridgeService, BridgeApiClient],
  exports: [BridgeService, BridgeApiClient],
})
export class BridgeModule {}

import { Module } from '@nestjs/common';
import {
  WalletsController,
  AdminWalletsController,
} from './wallets.controller';
import { WalletsService } from './wallets.service';
import { BridgeModule } from '../bridge/bridge.module';

@Module({
  imports: [BridgeModule],
  controllers: [WalletsController, AdminWalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}

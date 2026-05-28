import { Module } from '@nestjs/common';
import {
  WalletsController,
  AdminWalletsController,
} from './wallets.controller';
import { WalletsService } from './wallets.service';
import { BridgeModule } from '../bridge/bridge.module';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [BridgeModule, OrdersModule],
  controllers: [WalletsController, AdminWalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}

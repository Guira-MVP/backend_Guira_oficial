import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGateway } from './admin.gateway';
import { ReconciliationService } from './reconciliation.service';
import {
  AdminController,
  PublicSettingsController,
  ActivityController,
} from './admin.controller';

@Module({
  controllers: [AdminController, PublicSettingsController, ActivityController],
  providers: [AdminService, AdminGateway, ReconciliationService],
  exports: [AdminService, AdminGateway, ReconciliationService],
})
export class AdminModule {}

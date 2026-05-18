import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { ReconciliationService } from './reconciliation.service';
import {
  AdminController,
  PublicSettingsController,
  ActivityController,
} from './admin.controller';

@Module({
  controllers: [AdminController, PublicSettingsController, ActivityController],
  providers: [AdminService, ReconciliationService],
  exports: [AdminService, ReconciliationService],
})
export class AdminModule {}

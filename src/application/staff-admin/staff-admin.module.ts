import { Module } from '@nestjs/common';
import { StaffAdminController } from './staff-admin.controller';
import { StaffAdminService } from './staff-admin.service';

/**
 * EmailModule y SupabaseModule son @Global, por eso no se importan aquí.
 *
 * StaffAdminService se exporta porque OnboardingModule lo usa para bloquear
 * el alta en Bridge del personal interno.
 */
@Module({
  controllers: [StaffAdminController],
  providers: [StaffAdminService],
  exports: [StaffAdminService],
})
export class StaffAdminModule {}

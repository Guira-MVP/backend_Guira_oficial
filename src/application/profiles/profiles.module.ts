import { Module } from '@nestjs/common';
import {
  ProfilesController,
  AdminProfilesController,
} from './profiles.controller';
import { ProfilesService } from './profiles.service';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [AdminModule],
  controllers: [ProfilesController, AdminProfilesController],
  providers: [ProfilesService],
  exports: [ProfilesService],
})
export class ProfilesModule {}

import { Module } from '@nestjs/common';
import {
  ProfilesController,
  AdminProfilesController,
} from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  controllers: [ProfilesController, AdminProfilesController],
  providers: [ProfilesService],
  exports: [ProfilesService],
})
export class ProfilesModule {}

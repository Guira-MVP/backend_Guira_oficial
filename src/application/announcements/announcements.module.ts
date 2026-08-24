import { Module } from '@nestjs/common';
import { AnnouncementsService } from './announcements.service';
import {
  AnnouncementsController,
  AnnouncementsAdminController,
} from './announcements.controller';

@Module({
  controllers: [AnnouncementsController, AnnouncementsAdminController],
  providers: [AnnouncementsService],
  exports: [AnnouncementsService],
})
export class AnnouncementsModule {}

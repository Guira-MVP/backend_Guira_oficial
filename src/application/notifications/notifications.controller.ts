import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  ParseUUIDPipe,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import type { User } from '@supabase/supabase-js';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../../core/decorators/current-user.decorator';

@ApiTags('Notifications')
@ApiBearerAuth('supabase-jwt')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Obtener notificaciones del usuario logueado' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getNotifications(
    @CurrentUser() user: User,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.notificationsService.getNotifications(user.id, page, limit);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Cantidad de notificaciones no leídas' })
  getUnreadCount(@CurrentUser() user: User) {
    return this.notificationsService.getUnreadCount(user.id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Marcar todas las notificaciones como leídas' })
  readAll(@CurrentUser() user: User) {
    return this.notificationsService.markAllAsRead(user.id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Marcar una notificación específica como leída' })
  readOne(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: User,
  ) {
    return this.notificationsService.markAsRead(id, user.id);
  }
}

import {
  Injectable,
  Inject,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { CreateNotificationDto } from './dto/notifications.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  // Helper centralizado que usan TODOS los módulos
  async sendNotification(params: CreateNotificationDto): Promise<void> {
    const { error } = await this.supabase.from('notifications').insert({
      user_id: params.userId,
      type: params.type,
      title: params.title,
      message: params.message,
      link: params.link,
      reference_type: params.referenceType,
      reference_id: params.referenceId,
      is_read: false,
    });

    if (error) {
      this.logger.error(
        `Error enviando notificación a ${params.userId}: ${error.message}`,
      );
    }
  }

  async getNotifications(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const { data, count, error } = await this.supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new BadRequestException(error.message);

    return { data, total: count, page, limit };
  }

  async getUnreadCount(userId: string) {
    const { count, error } = await this.supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) throw new BadRequestException(error.message);
    return { unread_count: count ?? 0 };
  }

  async markAsRead(notificationId: string, userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', notificationId)
      .eq('user_id', userId);

    if (error) throw new BadRequestException(error.message);
  }

  async markAllAsRead(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) throw new BadRequestException(error.message);
  }
}

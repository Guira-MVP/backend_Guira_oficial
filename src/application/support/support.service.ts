import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import {
  CreateTicketDto,
  AssignTicketDto,
  ResolveTicketDto,
  UpdateTicketStatusDto,
} from './dto/support.dto';

@Injectable()
export class SupportService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  // ── CLIENTE ────────────────────────────────────────────────────────

  async createTicket(dto: CreateTicketDto, userId?: string) {
    const { data: ticket, error } = await this.supabase
      .from('support_tickets')
      .insert({
        ...dto,
        user_id: userId,
        status: 'open',
        priority: 'normal',
      })
      .select()
      .single();

    if (error)
      throw new BadRequestException(
        `No se pudo crear el ticket: ${error.message}`,
      );

    // TODO: Notificar al equipo de soporte vía notifications
    try {
      const { data: staffUsers } = await this.supabase
        .from('profiles')
        .select('id')
        .in('role', ['staff', 'admin', 'super_admin'])
        .eq('is_active', true);

      if (staffUsers?.length) {
        const notifications = staffUsers.map((s) => ({
          user_id: s.id,
          type: 'support',
          title: 'Nuevo Ticket de Soporte',
          message: `Ticket "${dto.subject}" fue creado.`,
          reference_type: 'support_ticket',
          reference_id: ticket.id,
          is_read: false,
        }));
        await this.supabase.from('notifications').insert(notifications);
      }
    } catch (err) {
      console.error(`Error notifying staff for ticket: ${err}`);
    }

    return ticket;
  }

  async getUserTickets(userId: string) {
    const { data, error } = await this.supabase
      .from('support_tickets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async getTicket(id: string, userId?: string) {
    let query = this.supabase.from('support_tickets').select('*').eq('id', id);

    // Si se pasa userId, validar que pertenece a ese usuario
    if (userId) {
      query = query.eq('user_id', userId);
    }

    const { data, error } = await query.single();
    if (error || !data) throw new NotFoundException('Ticket no encontrado');
    return data;
  }

  // ── ADMIN ──────────────────────────────────────────────────────────

  async getAllTickets(filters: Record<string, string>, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    let query = this.supabase
      .from('support_tickets')
      .select('*, profiles!support_tickets_user_id_fkey(email, full_name)', {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.assigned_to)
      query = query.eq('assigned_to', filters.assigned_to);

    const { data, count, error } = await query;
    if (error) throw new BadRequestException(error.message);

    return { data, total: count, page, limit };
  }

  async assignTicket(id: string, dto: AssignTicketDto, actorId: string) {
    const { data, error } = await this.supabase
      .from('support_tickets')
      .update({
        assigned_to: dto.staff_user_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'staff',
      action: 'ASSIGN_TICKET',
      table_name: 'support_tickets',
      record_id: id,
      new_values: { assigned_to: dto.staff_user_id },
      source: 'admin_panel',
    });

    return data;
  }

  async updateStatus(id: string, dto: UpdateTicketStatusDto, actorId: string) {
    const { data, error } = await this.supabase
      .from('support_tickets')
      .update({ status: dto.status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'staff',
      action: 'UPDATE_TICKET_STATUS',
      table_name: 'support_tickets',
      record_id: id,
      new_values: { status: dto.status },
      source: 'admin_panel',
    });

    return data;
  }

  async resolveTicket(id: string, dto: ResolveTicketDto, actorId: string) {
    const { data: ticket, error } = await this.supabase
      .from('support_tickets')
      .update({
        status: 'resolved',
        resolution_notes: dto.resolution_notes,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'staff',
      action: 'RESOLVE_TICKET',
      table_name: 'support_tickets',
      record_id: id,
      new_values: {
        status: 'resolved',
        resolution_notes: dto.resolution_notes,
      },
      source: 'admin_panel',
    });

    // Send notification to customer if they are registered
    if (ticket.user_id) {
      await this.supabase.from('notifications').insert({
        user_id: ticket.user_id,
        type: 'support',
        title: 'Ticket Resuelto',
        message: `Su ticket "${ticket.subject}" ha sido resuelto.`,
        reference_type: 'support_ticket',
        reference_id: ticket.id,
      });
    }

    return ticket;
  }
}

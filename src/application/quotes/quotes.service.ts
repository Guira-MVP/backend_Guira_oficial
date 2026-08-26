import { Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { CreateQuoteDto } from './dto/quotes.dto';

@Injectable()
export class QuotesService {
  private readonly logger = new Logger(QuotesService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  async create(dto: CreateQuoteDto, actorId: string, actorName: string, actorRole: string) {
    const { data, error } = await this.supabase
      .from('quote_history')
      .insert({
        ...dto,
        created_by: actorId,
        created_by_name: actorName,
      })
      .select()
      .single();

    if (error) throwDbError(error);

    await this.writeAuditLog({
      actorId,
      actorRole,
      action: 'CREATE_QUOTE',
      recordId: data.id,
      newValues: dto,
    });

    return data;
  }

  async list(filters: {
    phone?: string;
    date_from?: string;
    date_to?: string;
    page?: number;
    limit?: number;
  }) {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = this.supabase
      .from('quote_history')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (filters.phone) query = query.ilike('client_phone', `%${filters.phone}%`);
    if (filters.date_from) query = query.gte('created_at', filters.date_from);
    if (filters.date_to) query = query.lte('created_at', filters.date_to);

    const { data, error, count } = await query;

    if (error) throwDbError(error);

    return { data: data ?? [], total: count ?? 0, page, limit };
  }

  async getById(id: string) {
    const { data, error } = await this.supabase
      .from('quote_history')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Cotización no encontrada');
    return data;
  }

  private async writeAuditLog(params: {
    actorId: string;
    actorRole: string;
    action: string;
    recordId: string;
    newValues?: object;
  }) {
    const { error } = await this.supabase.from('audit_logs').insert({
      performed_by: params.actorId,
      role: params.actorRole,
      action: params.action,
      table_name: 'quote_history',
      record_id: params.recordId,
      new_values: params.newValues ?? null,
      source: 'admin_panel',
    });

    if (error) {
      this.logger.error(
        `Error registrando audit log de cotización ${params.recordId}: ${error.message}`,
      );
    }
  }
}

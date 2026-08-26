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

  /**
   * Historial agrupado por cliente (client_phone): un mismo número que pidió
   * varios servicios aparece una sola vez, con el conteo y la más reciente.
   * Se agrupa en memoria (no vía SQL GROUP BY) porque el volumen de
   * cotizaciones de staff es bajo — cientos, no millones — así que traer
   * las últimas GROUPING_SCAN_LIMIT filas y agrupar en JS es más simple que
   * mantener una función SQL aparte, y sigue siendo barato.
   */
  async listGrouped(filters: {
    phone?: string;
    page?: number;
    limit?: number;
  }) {
    const GROUPING_SCAN_LIMIT = 1000;
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 20, 100);

    let query = this.supabase
      .from('quote_history')
      .select('id, client_phone, client_name, client_company, flow_label, destination_currency, commission_percent, created_at, created_by_name')
      .order('created_at', { ascending: false })
      .limit(GROUPING_SCAN_LIMIT);

    if (filters.phone) query = query.ilike('client_phone', `%${filters.phone}%`);

    const { data, error } = await query;
    if (error) throwDbError(error);

    const rows = data ?? [];
    const groups = new Map<
      string,
      {
        client_phone: string;
        client_name: string | null;
        client_company: string | null;
        quote_count: number;
        last_created_at: string;
        last_created_by_name: string | null;
        services: string[];
      }
    >();

    for (const row of rows) {
      const existing = groups.get(row.client_phone);
      if (!existing) {
        groups.set(row.client_phone, {
          client_phone: row.client_phone,
          client_name: row.client_name,
          client_company: row.client_company,
          quote_count: 1,
          last_created_at: row.created_at,
          last_created_by_name: row.created_by_name,
          services: [`${row.flow_label} · ${row.destination_currency}`],
        });
        continue;
      }
      existing.quote_count += 1;
      const label = `${row.flow_label} · ${row.destination_currency}`;
      if (!existing.services.includes(label)) existing.services.push(label);
      // Las filas vienen ordenadas desc por fecha, así que la primera vista
      // por grupo ya es la más reciente — nombre/empresa/atendido-por solo
      // se completan si la fila más nueva los trae vacíos.
      if (!existing.client_name && row.client_name) existing.client_name = row.client_name;
      if (!existing.client_company && row.client_company) existing.client_company = row.client_company;
    }

    const allGroups = Array.from(groups.values()).sort(
      (a, b) => new Date(b.last_created_at).getTime() - new Date(a.last_created_at).getTime(),
    );

    const total = allGroups.length;
    const from = (page - 1) * limit;
    const paged = allGroups.slice(from, from + limit);

    return { data: paged, total, page, limit };
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

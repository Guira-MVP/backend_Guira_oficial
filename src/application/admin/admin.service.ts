import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { UpdateSettingDto, CreateSettingDto, UpdateCurrencySettingDto } from './dto/admin.dto';

@Injectable()
export class AdminService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  // ── APP SETTINGS ──────────────────────────────────────────────────

  async getPublicSettings() {
    const { data, error } = await this.supabase
      .from('app_settings')
      .select('key, value, type, description')
      .eq('is_public', true);

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async getAllSettings() {
    const { data, error } = await this.supabase
      .from('app_settings')
      .select('*')
      .order('key', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async getSetting(key: string) {
    const { data, error } = await this.supabase
      .from('app_settings')
      .select('*')
      .eq('key', key)
      .single();

    if (error || !data) throw new NotFoundException('Setting no encontrado');
    return data;
  }

  async updateSetting(key: string, dto: UpdateSettingDto, actorId: string) {
    const old = await this.getSetting(key);

    const { data, error } = await this.supabase
      .from('app_settings')
      .update({
        value: dto.value,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      })
      .eq('key', key)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'super_admin',
      action: 'UPDATE_SETTING',
      table_name: 'app_settings',
      record_id: null,
      previous_values: { value: old.value },
      new_values: { value: dto.value, key },
      source: 'admin_panel',
    });

    return data;
  }

  async createSetting(dto: CreateSettingDto, actorId: string) {
    const { data, error } = await this.supabase
      .from('app_settings')
      .insert({ ...dto, updated_by: actorId })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'super_admin',
      action: 'CREATE_SETTING',
      table_name: 'app_settings',
      record_id: null,
      new_values: dto,
      source: 'admin_panel',
    });

    return data;
  }

  // ── CURRENCY SETTINGS ─────────────────────────────────────────────

  async getCurrencySettings() {
    const { data, error } = await this.supabase
      .from('currency_settings')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async getActiveCurrencies(): Promise<string[]> {
    const { data, error } = await this.supabase
      .from('currency_settings')
      .select('currency')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((r) => r.currency);
  }

  async updateCurrencySetting(
    currency: string,
    dto: UpdateCurrencySettingDto,
    actorId: string,
  ) {
    const { data, error } = await this.supabase
      .from('currency_settings')
      .update({
        is_active: dto.is_active,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      })
      .eq('currency', currency)
      .select()
      .single();

    if (error || !data) throw new NotFoundException(`Divisa '${currency}' no encontrada`);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: 'admin',
      action: dto.is_active ? 'ENABLE_CURRENCY' : 'DISABLE_CURRENCY',
      table_name: 'currency_settings',
      record_id: null,
      new_values: { currency, is_active: dto.is_active },
      source: 'admin_panel',
    });

    return data;
  }

  // ── AUDIT LOGS ────────────────────────────────────────────────────

  async getAuditLogs(filters: Record<string, string>, page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    let query = this.supabase
      .from('audit_logs')
      .select('*, profiles!audit_logs_performed_by_fkey(email, full_name)', {
        count: 'exact',
      })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters.performed_by)
      query = query.eq('performed_by', filters.performed_by);
    if (filters.action) query = query.eq('action', filters.action);
    if (filters.table_name) query = query.eq('table_name', filters.table_name);

    // from_date / to_date could be added manually via query options

    const { data, count, error } = await query;
    if (error) throw new BadRequestException(error.message);

    return { data, total: count, page, limit };
  }

  async getUserAuditLogs(userId: string) {
    const { data, error } = await this.supabase
      .from('audit_logs')
      .select('*')
      .eq('performed_by', userId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  // ── ACTIVITY LOGS (Client Feed) ───────────────────────────────────

  async getUserActivityLogs(userId: string, limit = 50) {
    const { data, error } = await this.supabase
      .from('activity_logs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw new BadRequestException(error.message);
    return data;
  }
}

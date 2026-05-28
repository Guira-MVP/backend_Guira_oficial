import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { UpdateSettingDto, CreateSettingDto, UpdateCurrencySettingDto, UpdateVaSourceCurrencySettingDto } from './dto/admin.dto';
import { AdminGateway } from './admin.gateway';

@Injectable()
export class AdminService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly adminGateway: AdminGateway,
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

  async updateSetting(key: string, dto: UpdateSettingDto, actorId: string, actorRole: string) {
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
      role: actorRole,
      action: 'UPDATE_SETTING',
      table_name: 'app_settings',
      record_id: null,
      previous_values: { value: old.value },
      new_values: { value: dto.value, key },
      source: 'admin_panel',
    });

    // WS: notificar al staff que se actualizó un setting
    this.adminGateway.emitAppSettingUpdated({
      key: data.key,
      value: data.value ?? null,
      updated_at: data.updated_at ?? new Date().toISOString(),
      action: 'updated',
    });

    return data;
  }

  async createSetting(dto: CreateSettingDto, actorId: string, actorRole: string) {
    const { data, error } = await this.supabase
      .from('app_settings')
      .insert({ ...dto, updated_by: actorId })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: 'CREATE_SETTING',
      table_name: 'app_settings',
      record_id: null,
      new_values: dto,
      source: 'admin_panel',
    });

    // WS: notificar al staff que se creó un nuevo setting
    this.adminGateway.emitAppSettingUpdated({
      key: data.key,
      value: data.value ?? null,
      updated_at: data.updated_at ?? new Date().toISOString(),
      action: 'created',
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

  async getActiveCurrencies(context?: string): Promise<string[]> {
    let column = 'is_active';
    if (context === 'va') column = 'is_active_va';
    if (context === 'supplier') column = 'is_active_supplier';

    const { data, error } = await this.supabase
      .from('currency_settings')
      .select('currency')
      .eq(column, true)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((r) => r.currency);
  }

  async updateCurrencySetting(
    currency: string,
    dto: UpdateCurrencySettingDto,
    actorId: string,
    actorRole: string,
  ) {
    const updateData: Record<string, unknown> = {
      updated_by: actorId,
      updated_at: new Date().toISOString(),
    };
    if (dto.is_active !== undefined) updateData.is_active = dto.is_active;
    if (dto.is_active_va !== undefined) updateData.is_active_va = dto.is_active_va;
    if (dto.is_active_supplier !== undefined) updateData.is_active_supplier = dto.is_active_supplier;

    const { data, error } = await this.supabase
      .from('currency_settings')
      .update(updateData)
      .eq('currency', currency)
      .select()
      .single();

    if (error || !data) throw new NotFoundException(`Divisa '${currency}' no encontrada`);

    const changedField = dto.is_active_va !== undefined
      ? 'is_active_va'
      : dto.is_active_supplier !== undefined
        ? 'is_active_supplier'
        : 'is_active';
    const newValue = updateData[changedField] as boolean;

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: newValue ? 'ENABLE_CURRENCY' : 'DISABLE_CURRENCY',
      table_name: 'currency_settings',
      record_id: null,
      new_values: { currency, [changedField]: newValue },
      source: 'admin_panel',
    });

    return data;
  }

  // ── VA SOURCE CURRENCY SETTINGS ──────────────────────────────────

  async getVaSourceCurrencySettings() {
    const { data, error } = await this.supabase
      .from('va_source_currency_settings')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async getActiveVaSourceCurrencies() {
    const { data, error } = await this.supabase
      .from('va_source_currency_settings')
      .select('currency, label, rail_label, flag_iso, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async updateVaSourceCurrencySetting(
    currency: string,
    dto: UpdateVaSourceCurrencySettingDto,
    actorId: string,
    actorRole: string,
  ) {
    const { data, error } = await this.supabase
      .from('va_source_currency_settings')
      .update({
        is_active: dto.is_active,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      })
      .eq('currency', currency.toLowerCase())
      .select()
      .single();

    if (error || !data)
      throw new NotFoundException(`Moneda fiat '${currency}' no encontrada en VA source settings`);

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: dto.is_active ? 'ENABLE_VA_SOURCE_CURRENCY' : 'DISABLE_VA_SOURCE_CURRENCY',
      table_name: 'va_source_currency_settings',
      record_id: null,
      new_values: { currency, is_active: dto.is_active },
      source: 'admin_panel',
    });

    return data;
  }

  // ── AUDIT LOGS ────────────────────────────────────────────────────

  async getAuditLogs(
    filters: Record<string, string>,
    page = 1,
    limit = 50,
  ) {
    const offset = (page - 1) * limit;

    // Columnas ligeras: omitimos previous_values, new_values, details,
    // affected_fields y otros JSONB pesados que no se muestran en la tabla.
    const selectColumns = [
      'id',
      'performed_by',
      'role',
      'action',
      'table_name',
      'record_id',
      'reason',
      'source',
      'created_at',
      'profiles!audit_logs_performed_by_fkey(email,full_name)',
    ].join(',');

    let query = this.supabase
      .from('audit_logs')
      .select(selectColumns)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters.performed_by)
      query = query.eq('performed_by', filters.performed_by);
    if (filters.action) query = query.eq('action', filters.action);
    if (filters.table_name) query = query.eq('table_name', filters.table_name);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lte('created_at', filters.to);

    // Count en paralelo — consulta ligera sin JOIN ni JSONB.
    let countQuery = this.supabase
      .from('audit_logs')
      .select('id', { count: 'exact', head: true });

    if (filters.performed_by)
      countQuery = countQuery.eq('performed_by', filters.performed_by);
    if (filters.action) countQuery = countQuery.eq('action', filters.action);
    if (filters.table_name)
      countQuery = countQuery.eq('table_name', filters.table_name);
    if (filters.from) countQuery = countQuery.gte('created_at', filters.from);
    if (filters.to) countQuery = countQuery.lte('created_at', filters.to);

    const [{ data, error }, { count, error: countErr }] =
      await Promise.all([query, countQuery]);

    if (error) throw new BadRequestException(error.message);
    if (countErr) throw new BadRequestException(countErr.message);

    return { data, total: count ?? 0, page, limit };
  }

  async getUserAuditLogs(userId: string) {
    const { data, error } = await this.supabase
      .from('audit_logs')
      .select(
        'id, performed_by, role, action, table_name, record_id, reason, source, created_at',
      )
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

import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { UpdateSettingDto, CreateSettingDto, UpdateCurrencySettingDto, UpdateVaSourceCurrencySettingDto } from './dto/admin.dto';
import { AdminGateway } from './admin.gateway';

/**
 * Eventos de auth_audit_log que se exponen en el feed de actividad del cliente,
 * traducidos a la misma forma que activity_logs (action + description).
 * token_refresh/token_refresh_failed quedan fuera: ocurren en segundo plano
 * automáticamente y no son "actividad" perceptible por el usuario.
 */
const AUTH_ACTIVITY_LABELS: Record<
  string,
  { action: string; describe: (row: { ip_address: string | null; metadata: Record<string, unknown> | null }) => string }
> = {
  login_success: {
    action: 'LOGIN_EXITOSO',
    describe: (row) => `Inicio de sesión exitoso${row.ip_address ? ` desde ${row.ip_address}` : ''}`,
  },
  oauth_login: {
    action: 'LOGIN_OAUTH',
    describe: (row) => `Inicio de sesión con ${(row.metadata?.provider as string) ?? 'proveedor externo'}`,
  },
  logout: {
    action: 'CIERRE_SESION',
    describe: () => 'Cierre de sesión',
  },
  password_reset_request: {
    action: 'SOLICITUD_RESET_PASSWORD',
    describe: () => 'Solicitaste restablecer tu contraseña',
  },
  password_reset_success: {
    action: 'PASSWORD_ACTUALIZADA',
    describe: () => 'Contraseña actualizada',
  },
  password_reset_failed: {
    action: 'PASSWORD_RESET_FALLIDO',
    describe: () => 'Intento fallido de restablecer contraseña',
  },
  mfa_disabled_by_admin: {
    action: 'MFA_DESACTIVADO',
    describe: () => 'Verificación en dos pasos desactivada por soporte',
  },
  session_revoked: {
    action: 'SESION_CERRADA',
    describe: () => 'Cerraste una sesión activa desde otro dispositivo',
  },
  session_revoked_bulk: {
    action: 'SESIONES_CERRADAS',
    describe: (row) => `Cerraste todas tus otras sesiones activas${row.metadata?.revoked_count ? ` (${row.metadata.revoked_count})` : ''}`,
  },
};

/**
 * Acciones de audit_logs (auditoría de sistema, normalmente solo staff)
 * que además son iniciadas por el propio cliente y por eso se exponen
 * también en su feed de actividad. Filtradas siempre por performed_by = userId.
 */
const CLIENT_AUDIT_LABELS: Record<
  string,
  {
    action: string;
    describe: (row: { new_values: Record<string, unknown> | null; old_values: Record<string, unknown> | null }) => string;
  }
> = {
  CREATE_BANK_ACCOUNT: {
    action: 'CUENTA_BANCARIA_AGREGADA',
    describe: (row) => `Agregaste la cuenta bancaria ${(row.new_values?.bank_name as string) ?? ''}`.trim(),
  },
  REQUEST_BANK_ACCOUNT_UPDATE: {
    action: 'SOLICITUD_ACTUALIZAR_CUENTA',
    describe: () => 'Solicitaste actualizar los datos de una cuenta bancaria',
  },
  CREATE_PAYMENT_ORDER: {
    action: 'ORDEN_CREADA',
    describe: (row) =>
      `Creaste una orden (${(row.new_values?.flow_type as string) ?? ''}) por ${(row.new_values?.amount as string) ?? ''} ${(row.new_values?.currency as string) ?? ''}`.trim(),
  },
  CREATE_WALLET_RAMP_ORDER: {
    action: 'ORDEN_CREADA',
    describe: (row) =>
      `Creaste una orden (${(row.new_values?.flow_type as string) ?? ''}) por ${(row.new_values?.amount as string) ?? ''} ${(row.new_values?.currency as string) ?? ''}`.trim(),
  },
  CREATE_REVIEW_REQUEST: {
    action: 'SOLICITUD_REVISION_CREADA',
    describe: (row) => `Solicitaste revisión por exceder el límite (${(row.new_values?.flow_type as string) ?? ''})`,
  },
  CANCEL_REVIEW_REQUEST: {
    action: 'SOLICITUD_REVISION_CANCELADA',
    describe: () => 'Cancelaste tu solicitud de revisión de límite',
  },
};

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

    if (error) throwDbError(error);
    return data;
  }

  async getAllSettings() {
    const { data, error } = await this.supabase
      .from('app_settings')
      .select('*')
      .order('key', { ascending: true });

    if (error) throwDbError(error);
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

    if (error) throwDbError(error);

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

    if (error) throwDbError(error);

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

    if (error) throwDbError(error);
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

    if (error) throwDbError(error);
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

    if (error) throwDbError(error);
    return data;
  }

  async getActiveVaSourceCurrencies() {
    const { data, error } = await this.supabase
      .from('va_source_currency_settings')
      .select('currency, label, rail_label, flag_iso, is_active, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) throwDbError(error);
    return data ?? [];
  }

  async updateVaSourceCurrencySetting(
    currency: string,
    dto: UpdateVaSourceCurrencySettingDto,
    actorId: string,
    actorRole: string,
  ) {
    const updateData: Record<string, unknown> = {
      updated_by: actorId,
      updated_at: new Date().toISOString(),
    };
    if (dto.is_active !== undefined) updateData.is_active = dto.is_active;
    if (dto.is_active_supplier !== undefined) updateData.is_active_supplier = dto.is_active_supplier;

    const { data, error } = await this.supabase
      .from('va_source_currency_settings')
      .update(updateData)
      .eq('currency', currency.toLowerCase())
      .select()
      .single();

    if (error || !data)
      throw new NotFoundException(`Moneda fiat '${currency}' no encontrada en VA source settings`);

    const changedField = dto.is_active_supplier !== undefined ? 'is_active_supplier' : 'is_active';
    const newValue = updateData[changedField] as boolean;
    const action = changedField === 'is_active_supplier'
      ? (newValue ? 'ENABLE_FIAT_SUPPLIER_CURRENCY' : 'DISABLE_FIAT_SUPPLIER_CURRENCY')
      : (newValue ? 'ENABLE_VA_SOURCE_CURRENCY' : 'DISABLE_VA_SOURCE_CURRENCY');

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action,
      table_name: 'va_source_currency_settings',
      record_id: null,
      new_values: { currency, [changedField]: newValue },
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

    // Columnas del listado: incluye affected_fields (text[], liviano) e ip_address.
    // previous_values / new_values se omiten aquí — se sirven en el endpoint de detalle.
    const selectColumns = [
      'id',
      'performed_by',
      'role',
      'action',
      'table_name',
      'record_id',
      'affected_fields',
      'ip_address',
      'reason',
      'source',
      'created_at',
      'profiles!audit_logs_performed_by_fkey(email,full_name)',
    ].join(',');

    // exclude_system=true (default) oculta eventos automáticos de sistema
    // (source='system') que generan decenas de miles de filas de ruido.
    const excludeSystem = filters.exclude_system !== 'false';

    let query = this.supabase
      .from('audit_logs')
      .select(selectColumns)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (excludeSystem) query = query.neq('source', 'system');
    if (filters.performed_by)
      query = query.eq('performed_by', filters.performed_by);
    if (filters.action) query = query.eq('action', filters.action);
    if (filters.table_name) query = query.eq('table_name', filters.table_name);
    if (filters.source) query = query.eq('source', filters.source);
    if (filters.from) query = query.gte('created_at', filters.from);
    if (filters.to) query = query.lte('created_at', filters.to);

    // Count en paralelo — consulta ligera sin JOIN ni arrays.
    let countQuery = this.supabase
      .from('audit_logs')
      .select('id', { count: 'exact', head: true });

    if (excludeSystem) countQuery = countQuery.neq('source', 'system');
    if (filters.performed_by)
      countQuery = countQuery.eq('performed_by', filters.performed_by);
    if (filters.action) countQuery = countQuery.eq('action', filters.action);
    if (filters.table_name)
      countQuery = countQuery.eq('table_name', filters.table_name);
    if (filters.source) countQuery = countQuery.eq('source', filters.source);
    if (filters.from) countQuery = countQuery.gte('created_at', filters.from);
    if (filters.to) countQuery = countQuery.lte('created_at', filters.to);

    const [{ data, error }, { count, error: countErr }] =
      await Promise.all([query, countQuery]);

    if (error) throwDbError(error);
    if (countErr) throw new BadRequestException(countErr.message);

    return { data, total: count ?? 0, page, limit };
  }

  async getAuditLogDetail(id: string) {
    const { data, error } = await this.supabase
      .from('audit_logs')
      .select(
        'id, performed_by, role, action, table_name, record_id, affected_fields, previous_values, new_values, reason, source, ip_address, created_at, profiles!audit_logs_performed_by_fkey(email,full_name)',
      )
      .eq('id', id)
      .single();

    if (error) throwDbError(error);
    if (!data) throw new NotFoundException('Audit log no encontrado');
    return data;
  }

  async getUserAuditLogs(userId: string, page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const { data, error, count } = await this.supabase
      .from('audit_logs')
      .select(
        'id, performed_by, role, action, table_name, record_id, affected_fields, ip_address, reason, source, created_at',
        { count: 'exact' },
      )
      .eq('performed_by', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throwDbError(error);
    return { data, total: count ?? 0, page, limit };
  }

  // ── ACTIVITY LOGS (Client Feed) ───────────────────────────────────

  /**
   * Feed de actividad del cliente, paginado a nivel de DB sobre la vista
   * `client_activity_feed` (UNION ALL de activity_logs + auth_audit_log +
   * audit_logs, ya filtrada por la whitelist de acciones/eventos relevantes
   * — ver AUTH_ACTIVITY_LABELS / CLIENT_AUDIT_LABELS arriba, que deben
   * mantenerse sincronizadas con la whitelist de la vista).
   * Solo se traducen a español las filas de la página pedida, nunca todo
   * el histórico.
   */
  async getUserActivityLogs(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase
      .from('client_activity_feed')
      .select('id, user_id, source_kind, raw_action, raw_description, raw_ip_address, metadata, created_at', {
        count: 'exact',
      })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throwDbError(error);

    const normalized = (data ?? []).map((row) => {
      if (row.source_kind === 'auth') {
        const label = AUTH_ACTIVITY_LABELS[row.raw_action];
        return {
          id: row.id,
          user_id: row.user_id,
          action: label?.action ?? row.raw_action,
          description: label
            ? label.describe({ ip_address: row.raw_ip_address, metadata: row.metadata })
            : row.raw_action,
          metadata: row.metadata,
          created_at: row.created_at,
        };
      }

      if (row.source_kind === 'audit') {
        const label = CLIENT_AUDIT_LABELS[row.raw_action];
        return {
          id: row.id,
          user_id: row.user_id,
          action: label?.action ?? row.raw_action,
          description: label ? label.describe({ new_values: row.metadata, old_values: null }) : row.raw_action,
          metadata: row.metadata,
          created_at: row.created_at,
        };
      }

      // source_kind === 'operation' — ya viene con action/description listos
      return {
        id: row.id,
        user_id: row.user_id,
        action: row.raw_action,
        description: row.raw_description,
        metadata: row.metadata,
        created_at: row.created_at,
      };
    });

    return { data: normalized, total: count ?? 0, page, limit };
  }
}

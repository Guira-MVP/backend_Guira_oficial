import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcements.dto';

/** Campos cuyo cambio implica "contenido nuevo" → se incrementa `version`. */
const CONTENT_FIELDS = [
  'title',
  'badge',
  'body',
  'items',
  'cta_label',
  'cta_url',
] as const;

@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  // ── Lectura del cliente ───────────────────────────────────────────

  /**
   * Anuncio vigente que debe ver el cliente al iniciar sesión.
   * Devuelve `null` si no hay ninguno activo dentro de su ventana de vigencia.
   */
  async getActiveForClient() {
    const { data, error } = await this.supabase
      .from('announcements')
      .select(
        'id, title, badge, body, items, cta_label, cta_url, version, publish_at, expires_at',
      )
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throwDbError(error);

    // La ventana de vigencia se filtra aquí: son pocas filas y evita depender
    // de cómo PostgREST combina varios filtros `or` sobre columnas nullables.
    const now = Date.now();
    const vigente = (data ?? []).find((row) => {
      const publishedOk =
        !row.publish_at || new Date(row.publish_at).getTime() <= now;
      const notExpired =
        !row.expires_at || new Date(row.expires_at).getTime() > now;
      return publishedOk && notExpired;
    });

    if (!vigente) return null;

    const { expires_at: _expiresAt, ...publicFields } = vigente;
    return publicFields;
  }

  // ── Gestión del staff ─────────────────────────────────────────────

  async list() {
    const { data, error } = await this.supabase
      .from('announcements')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throwDbError(error);
    return data;
  }

  async getById(id: string) {
    const { data, error } = await this.supabase
      .from('announcements')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) throw new NotFoundException('Anuncio no encontrado');
    return data;
  }

  async create(dto: CreateAnnouncementDto, actorId: string, actorRole: string) {
    const { data, error } = await this.supabase
      .from('announcements')
      .insert({
        ...dto,
        items: dto.items ?? [],
        created_by: actorId,
        updated_by: actorId,
      })
      .select()
      .single();

    if (error) throwDbError(error);

    await this.writeAuditLog({
      actorId,
      actorRole,
      action: 'CREATE_ANNOUNCEMENT',
      recordId: data.id,
      newValues: dto,
    });

    return data;
  }

  async update(
    id: string,
    dto: UpdateAnnouncementDto,
    actorId: string,
    actorRole: string,
  ) {
    const previous = await this.getById(id);

    const contentChanged = CONTENT_FIELDS.some(
      (field) =>
        dto[field] !== undefined &&
        JSON.stringify(dto[field]) !== JSON.stringify(previous[field]),
    );

    const { data, error } = await this.supabase
      .from('announcements')
      .update({
        ...dto,
        // Contenido nuevo → los clientes que ya lo cerraron vuelven a verlo.
        ...(contentChanged ? { version: (previous.version ?? 1) + 1 } : {}),
        updated_by: actorId,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throwDbError(error);

    await this.writeAuditLog({
      actorId,
      actorRole,
      action: 'UPDATE_ANNOUNCEMENT',
      recordId: id,
      previousValues: previous,
      newValues: dto,
    });

    return data;
  }

  async remove(id: string, actorId: string, actorRole: string) {
    const previous = await this.getById(id);

    const { error } = await this.supabase
      .from('announcements')
      .delete()
      .eq('id', id);

    if (error) throwDbError(error);

    await this.writeAuditLog({
      actorId,
      actorRole,
      action: 'DELETE_ANNOUNCEMENT',
      recordId: id,
      previousValues: previous,
    });

    return { success: true };
  }

  // ── Auditoría ─────────────────────────────────────────────────────

  /** Mismo formato que AdminService.updateSetting: nunca rompe la operación principal. */
  private async writeAuditLog(params: {
    actorId: string;
    actorRole: string;
    action: string;
    recordId: string;
    previousValues?: object;
    newValues?: object;
  }) {
    const { error } = await this.supabase.from('audit_logs').insert({
      performed_by: params.actorId,
      role: params.actorRole,
      action: params.action,
      table_name: 'announcements',
      record_id: params.recordId,
      previous_values: params.previousValues ?? null,
      new_values: params.newValues ?? null,
      source: 'admin_panel',
    });

    if (error) {
      this.logger.error(
        `Error registrando audit log de anuncio ${params.recordId}: ${error.message}`,
      );
    }
  }
}

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { STAFF_REVIEW_GATED_FLOWS } from './staff-review-gate';

export interface FlowReviewSetting {
  flow_type: string;
  label: string;
  flow_category: 'interbank' | 'wallet_ramp';
  requires_staff_review: boolean;
  sort_order: number;
  updated_by: string | null;
  updated_at: string;
}

/**
 * Switch por flujo de la puerta de revisión de staff.
 *
 * Decide si un expediente nace en 'pending_review' (esperando que alguien
 * verifique documentación y motivo) o si se ejecuta de inmediato como antes.
 *
 * La consulta va en el camino crítico de CADA creación de expediente, así que
 * se cachea en memoria unos segundos. La ventana es corta a propósito: apagar
 * el switch por una incidencia debe surtir efecto casi al instante, y de todas
 * formas el guardado invalida la caché del proceso que lo atendió.
 */
@Injectable()
export class FlowReviewSettingsService {
  private readonly logger = new Logger(FlowReviewSettingsService.name);

  private static readonly CACHE_TTL_MS = 15_000;
  private cache: Map<string, boolean> | null = null;
  private cacheExpiresAt = 0;

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient) {}

  /** Listado completo para el panel del staff. */
  async listSettings(): Promise<FlowReviewSetting[]> {
    const { data, error } = await this.supabase
      .from('flow_review_settings')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) throwDbError(error);
    return (data ?? []) as FlowReviewSetting[];
  }

  async updateSetting(
    flowType: string,
    requiresStaffReview: boolean,
    actorId: string,
    actorRole: string,
  ): Promise<FlowReviewSetting> {
    const { data, error } = await this.supabase
      .from('flow_review_settings')
      .update({
        requires_staff_review: requiresStaffReview,
        updated_by: actorId,
        updated_at: new Date().toISOString(),
      })
      .eq('flow_type', flowType)
      .select()
      .maybeSingle();

    if (error) throwDbError(error);
    if (!data) {
      throw new NotFoundException(
        `El flujo "${flowType}" no existe en la configuración de revisión.`,
      );
    }

    this.invalidateCache();

    await this.supabase.from('audit_logs').insert({
      performed_by: actorId,
      role: actorRole,
      action: requiresStaffReview
        ? 'ENABLE_FLOW_STAFF_REVIEW'
        : 'DISABLE_FLOW_STAFF_REVIEW',
      table_name: 'flow_review_settings',
      record_id: flowType,
      previous_values: { requires_staff_review: !requiresStaffReview },
      new_values: { requires_staff_review: requiresStaffReview },
      source: 'admin_panel',
    });

    this.logger.log(
      `🔀 Revisión de staff ${requiresStaffReview ? 'ACTIVADA' : 'DESACTIVADA'} para ${flowType} por ${actorId}`,
    );

    return data as FlowReviewSetting;
  }

  /**
   * ¿Este expediente debe nacer esperando revisión del staff?
   *
   * Ante cualquier duda devuelve `true`: si la tabla no responde o el flujo no
   * está configurado, es preferible que un expediente espere a un humano antes
   * que dejar salir dinero sin revisar.
   */
  async requiresReview(flowType: string | null | undefined): Promise<boolean> {
    if (!flowType) return false;

    // Un flujo que el código no sabe ejecutar en dos fases no puede pasar por
    // la puerta aunque alguien inserte una fila para él.
    if (!(STAFF_REVIEW_GATED_FLOWS as readonly string[]).includes(flowType)) {
      return false;
    }

    const settings = await this.loadCache();
    return settings.get(flowType) ?? true;
  }

  private async loadCache(): Promise<Map<string, boolean>> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) return this.cache;

    try {
      const { data, error } = await this.supabase
        .from('flow_review_settings')
        .select('flow_type, requires_staff_review');

      if (error) throw error;

      const map = new Map<string, boolean>();
      for (const row of data ?? []) {
        map.set(row.flow_type as string, Boolean(row.requires_staff_review));
      }
      this.cache = map;
      this.cacheExpiresAt = now + FlowReviewSettingsService.CACHE_TTL_MS;
      return map;
    } catch (err) {
      // Sin configuración legible, requiresReview() cae al default seguro.
      this.logger.error(
        `No se pudo leer flow_review_settings: ${(err as Error).message}. ` +
          `Se asume revisión de staff activada para todos los flujos.`,
      );
      return new Map();
    }
  }

  private invalidateCache(): void {
    this.cache = null;
    this.cacheExpiresAt = 0;
  }
}

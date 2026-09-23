import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import { throwDbError } from '../../core/utils/db-error.util';
import { AdminGateway } from '../admin/admin.gateway';
import { SaveOnboardingDraftDto } from './dto/save-onboarding-draft.dto';

const STORAGE_BUCKET = 'kyc-documents';

/** Tope del JSON serializado del formulario. Un KYB con varios UBOs ronda 10 KB. */
const MAX_DRAFT_BYTES = 64 * 1024;
const MAX_DEPTH = 4;
const MAX_KEYS_PER_OBJECT = 200;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 5000;
const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/** Borradores sin actividad por más de este plazo se eliminan (minimización de PII). */
export const DRAFT_RETENTION_DAYS = 90;

/** El staff recibe como máximo un aviso por usuario en esta ventana. */
const STAFF_EMIT_THROTTLE_MS = 20_000;

/**
 * Estados de aplicación en los que el cliente todavía puede editar su
 * formulario. Fuera de estos, el expediente ya está en manos del staff o del
 * proveedor y un autosave rezagado no debe resucitar el borrador.
 */
const EDITABLE_APPLICATION_STATUSES = new Set(['pending', 'in_progress', 'needs_review']);

export interface DraftMissingField {
  key: string;
  label: string;
  step: number | null;
  reason: 'missing' | 'invalid';
  message: string | null;
}

export interface OnboardingDraftRow {
  user_id: string;
  type: 'personal' | 'company';
  step: number;
  data: Record<string, unknown>;
  missing_fields: DraftMissingField[];
  progress_pct: number;
  created_at: string;
  updated_at: string;
}

interface DocumentToRemove {
  id: string;
  storage_path: string | null;
}

@Injectable()
export class OnboardingDraftService {
  private readonly logger = new Logger(OnboardingDraftService.name);
  private readonly lastStaffEmit = new Map<string, number>();

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly adminGateway: AdminGateway,
  ) {}

  // ── Cliente ───────────────────────────────────────────────────────

  async getDraft(userId: string): Promise<OnboardingDraftRow | null> {
    const { data, error } = await this.supabase
      .from('onboarding_drafts')
      .select('user_id, type, step, data, missing_fields, progress_pct, created_at, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throwDbError(error);
    return (data as OnboardingDraftRow | null) ?? null;
  }

  async saveDraft(userId: string, dto: SaveOnboardingDraftDto) {
    await this.assertDraftEditable(userId);

    const data = this.sanitizeData(dto.data);
    const missingFields = this.sanitizeMissingFields(dto.missing_fields);
    const next = {
      type: dto.type,
      step: dto.step,
      data,
      missing_fields: missingFields,
      progress_pct: dto.progress_pct,
    };

    // El frontend ya evita reenviar lo mismo, pero dos pestañas o un reintento
    // pueden mandar un payload idéntico: no reescribimos ni avisamos al staff.
    const current = await this.getDraft(userId);
    if (
      current &&
      stableStringify({
        type: current.type,
        step: current.step,
        data: current.data,
        missing_fields: current.missing_fields,
        progress_pct: current.progress_pct,
      }) === stableStringify(next)
    ) {
      return { updated_at: current.updated_at, unchanged: true };
    }

    const { data: row, error } = await this.supabase
      .from('onboarding_drafts')
      .upsert(
        { user_id: userId, ...next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      )
      .select('updated_at')
      .single();
    if (error) throwDbError(error);

    this.notifyStaff(userId, {
      type: dto.type,
      progress_pct: dto.progress_pct,
      updated_at: row.updated_at,
      action: 'saved',
    });

    return { updated_at: row.updated_at as string, unchanged: false };
  }

  /**
   * Descarta el borrador (p. ej. "Cambiar de tipo"). Con `withDocuments`
   * también borra los documentos que el cliente subió y todavía no envió.
   */
  async deleteDraft(userId: string, opts: { withDocuments?: boolean } = {}) {
    if (opts.withDocuments) {
      const { data: docs, error } = await this.supabase
        .from('documents')
        .select('id, storage_path')
        .eq('user_id', userId)
        .eq('is_draft', true);
      if (error) throwDbError(error);
      await this.hardDeleteDocuments((docs ?? []) as DocumentToRemove[]);
    }

    const { error } = await this.supabase
      .from('onboarding_drafts')
      .delete()
      .eq('user_id', userId);
    if (error) throwDbError(error);

    this.notifyStaff(
      userId,
      { type: null, progress_pct: null, updated_at: new Date().toISOString(), action: 'deleted' },
      true,
    );
    return { deleted: true };
  }

  /**
   * Llamado al enviar la solicitud con éxito: los documentos pasan a estar
   * "enviados" (ya no se pueden borrar, solo reemplazar con historial) y el
   * borrador se elimina porque los datos ya viven en people/businesses.
   * Best-effort: un fallo aquí no debe revertir un envío ya hecho.
   */
  async markSubmitted(userId: string) {
    try {
      const { error: docsError } = await this.supabase
        .from('documents')
        .update({ is_draft: false })
        .eq('user_id', userId)
        .eq('is_draft', true);
      if (docsError) throw docsError;

      const { error } = await this.supabase
        .from('onboarding_drafts')
        .delete()
        .eq('user_id', userId);
      if (error) throw error;

      this.notifyStaff(
        userId,
        { type: null, progress_pct: null, updated_at: new Date().toISOString(), action: 'deleted' },
        true,
      );
    } catch (err) {
      this.logger.error(
        `No se pudo cerrar el borrador de onboarding del usuario ${userId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Borra de verdad documentos de borrador: primero los objetos de Storage y
   * después las filas. Si Storage falla se conservan las filas, para no dejar
   * archivos huérfanos sin rastro en la DB.
   */
  async hardDeleteDocuments(docs: DocumentToRemove[]) {
    if (docs.length === 0) return;

    const paths = docs.map((d) => d.storage_path).filter((p): p is string => !!p);
    if (paths.length > 0) {
      const { error: storageError } = await this.supabase.storage
        .from(STORAGE_BUCKET)
        .remove(paths);
      if (storageError) {
        this.logger.error(`Error borrando documentos de borrador en Storage: ${storageError.message}`);
        throw new BadRequestException('No se pudo eliminar el documento. Intenta nuevamente.');
      }
    }

    const { error } = await this.supabase
      .from('documents')
      .delete()
      .in('id', docs.map((d) => d.id));
    if (error) throwDbError(error);
  }

  // ── Retención ─────────────────────────────────────────────────────

  /** Elimina borradores abandonados y los documentos que nunca se enviaron. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'onboarding-draft-retention' })
  async purgeStaleDrafts() {
    const cutoff = new Date(Date.now() - DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data: stale, error } = await this.supabase
      .from('onboarding_drafts')
      .select('user_id')
      .lt('updated_at', cutoff)
      .limit(200);
    if (error) {
      this.logger.error(`Retención de borradores: ${error.message}`);
      return;
    }

    for (const { user_id: userId } of stale ?? []) {
      try {
        await this.deleteDraft(userId as string, { withDocuments: true });
      } catch (err) {
        this.logger.error(
          `Retención de borradores: no se pudo borrar el del usuario ${userId}: ${(err as Error).message}`,
        );
      }
    }

    if (stale?.length) {
      this.logger.log(`Retención: ${stale.length} borrador(es) de onboarding eliminado(s)`);
    }
  }

  // ── Internos ──────────────────────────────────────────────────────

  private async assertDraftEditable(userId: string) {
    const [{ data: kyc }, { data: kyb }] = await Promise.all([
      this.supabase
        .from('kyc_applications')
        .select('status, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      this.supabase
        .from('kyb_applications')
        .select('status, created_at')
        .eq('requester_user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const latest = [kyc, kyb]
      .filter((a): a is { status: string; created_at: string } => !!a)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

    if (latest && !EDITABLE_APPLICATION_STATUSES.has(latest.status)) {
      throw new ConflictException(
        'Tu solicitud ya fue enviada; el borrador no se puede modificar.',
      );
    }
  }

  private sanitizeData(input: Record<string, unknown>): Record<string, unknown> {
    const clean = sanitizeValue(input, 0);
    if (!clean || typeof clean !== 'object' || Array.isArray(clean)) {
      throw new BadRequestException('Borrador inválido');
    }
    if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_DRAFT_BYTES) {
      throw new BadRequestException('El borrador excede el tamaño permitido');
    }
    return clean as Record<string, unknown>;
  }

  private sanitizeMissingFields(input: unknown[]): DraftMissingField[] {
    const out: DraftMissingField[] = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const raw = item as Record<string, unknown>;
      if (typeof raw.key !== 'string' || !/^[a-z0-9_]{1,80}$/i.test(raw.key)) continue;
      out.push({
        key: raw.key,
        label: typeof raw.label === 'string' ? raw.label.slice(0, 160) : raw.key,
        step: typeof raw.step === 'number' && Number.isInteger(raw.step) ? raw.step : null,
        reason: raw.reason === 'invalid' ? 'invalid' : 'missing',
        message: typeof raw.message === 'string' ? raw.message.slice(0, 300) : null,
      });
    }
    return out;
  }

  private notifyStaff(
    userId: string,
    payload: Omit<Parameters<AdminGateway['emitOnboardingDraftUpdated']>[0], 'user_id'>,
    force = false,
  ) {
    const now = Date.now();
    const last = this.lastStaffEmit.get(userId) ?? 0;
    if (!force && now - last < STAFF_EMIT_THROTTLE_MS) return;
    this.lastStaffEmit.set(userId, now);

    // El mapa no debe crecer sin límite en un proceso de larga vida.
    if (this.lastStaffEmit.size > 5000) {
      for (const [key, ts] of this.lastStaffEmit) {
        if (now - ts > STAFF_EMIT_THROTTLE_MS) this.lastStaffEmit.delete(key);
      }
    }

    try {
      this.adminGateway.emitOnboardingDraftUpdated({ user_id: userId, ...payload });
    } catch (err) {
      this.logger.warn(`No se pudo emitir onboarding_draft_updated: ${(err as Error).message}`);
    }
  }
}

/**
 * Copia defensiva del JSON del cliente: solo tipos JSON planos, claves en
 * snake_case (descarta __proto__, constructor, etc.) y límites de tamaño.
 */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (depth >= MAX_DEPTH) return null;

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (count >= MAX_KEYS_PER_OBJECT) break;
      if (!SAFE_KEY.test(key)) continue;
      const clean = sanitizeValue(child, depth + 1);
      if (clean === undefined) continue;
      out[key] = clean;
      count++;
    }
    return out;
  }

  return undefined;
}

/** JSON con claves ordenadas: jsonb de Postgres no preserva el orden. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export const __test__ = { sanitizeValue };

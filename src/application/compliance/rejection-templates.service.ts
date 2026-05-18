import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../core/supabase/supabase.module';
import {
  CreateRejectionTemplateDto,
  UpdateRejectionTemplateDto,
} from './dto/rejection-templates.dto';

@Injectable()
export class RejectionTemplatesService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  /**
   * List active templates, optionally filtered by category.
   * Used by staff to populate quick-comment chips.
   */
  async list(category?: string) {
    let query = this.supabase
      .from('rejection_templates')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  /**
   * List ALL templates (including inactive) for admin management.
   */
  async listAll(category?: string) {
    let query = this.supabase
      .from('rejection_templates')
      .select('*')
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true });

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  /**
   * Create a new template.
   */
  async create(dto: CreateRejectionTemplateDto, createdBy?: string) {
    const { data, error } = await this.supabase
      .from('rejection_templates')
      .insert({
        category: dto.category,
        label: dto.label,
        body: dto.body,
        sort_order: dto.sort_order ?? 0,
        created_by: createdBy ?? null,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update an existing template (label, body, is_active, sort_order).
   */
  async update(id: string, dto: UpdateRejectionTemplateDto) {
    const updatePayload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (dto.label !== undefined) updatePayload.label = dto.label;
    if (dto.body !== undefined) updatePayload.body = dto.body;
    if (dto.is_active !== undefined) updatePayload.is_active = dto.is_active;
    if (dto.sort_order !== undefined) updatePayload.sort_order = dto.sort_order;

    const { data, error } = await this.supabase
      .from('rejection_templates')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException('Template no encontrado');
    return data;
  }

  /**
   * Soft-delete: set is_active = false.
   */
  async softDelete(id: string) {
    const { data, error } = await this.supabase
      .from('rejection_templates')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) throw new NotFoundException('Template no encontrado');
    return { deleted: true };
  }
}

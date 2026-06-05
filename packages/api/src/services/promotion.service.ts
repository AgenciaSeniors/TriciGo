import { getSupabaseClient } from '../client';

export type PromotionType = 'percentage_discount' | 'fixed_discount' | 'bonus_credit';

export interface Promotion {
  id: string;
  code: string;
  type: PromotionType;
  discount_percent: number | null;
  discount_fixed_cup: number | null;
  max_uses: number | null;
  current_uses: number;
  is_active: boolean;
  valid_from: string;
  valid_until: string | null;
  // Fase 3: marketing copy + "notificar al publicar". title_es/body_es
  // feed both the admin display and the push payload.
  title_es: string | null;
  body_es: string | null;
  image_url: string | null;
  notify_on_publish: boolean;
  notified_at: string | null;
  created_by: string | null;
  created_at: string;
}

// current_uses / created_at / created_by are server/DB-owned.
export type CreatePromotionInput = Omit<
  Promotion,
  'id' | 'current_uses' | 'created_at' | 'created_by'
>;

export const promotionService = {
  async getAll(page = 0, pageSize = 20): Promise<Promotion[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('promotions')
      .select('*')
      .order('created_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    return (data ?? []) as Promotion[];
  },

  async create(payload: CreatePromotionInput): Promise<Promotion> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('promotions')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data as Promotion;
  },

  async update(id: string, updates: Partial<Promotion>): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('promotions')
      .update(updates)
      .eq('id', id);
    if (error) throw error;
  },

  async setActive(id: string, isActive: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('promotions')
      .update({ is_active: isActive })
      .eq('id', id);
    if (error) throw error;
  },

  async remove(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('promotions')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },
};

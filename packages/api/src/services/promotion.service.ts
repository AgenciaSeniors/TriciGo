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
  /** 00482: redeemable only by customers with zero completed rides. */
  first_ride_only: boolean;
  created_by: string | null;
  created_at: string;
}

// current_uses / created_at / created_by are server/DB-owned.
export type CreatePromotionInput = Omit<
  Promotion,
  'id' | 'current_uses' | 'created_at' | 'created_by'
>;

/** Marketing-safe subset returned by the SECURITY DEFINER RPC
 *  `get_active_promotions` (mig 00476). The promotions table itself is
 *  admin-only under RLS (00321) — user-facing feeds MUST go through this
 *  RPC, never `.from('promotions')` (that query silently returns 0 rows
 *  for non-admins). */
export interface ActivePromotion {
  id: string;
  code: string;
  type: PromotionType;
  discount_percent: number | null;
  discount_fixed_cup: number | null;
  valid_until: string | null;
  title_es: string | null;
  body_es: string | null;
  image_url: string | null;
}

export const promotionService = {
  /** Active, in-window promos with remaining uses, for user-facing home
   *  feeds. Tolerant: returns [] when the RPC isn't deployed yet
   *  (migration 00476 pending in prod) or on any error — callers hide
   *  the section on empty, same behavior as before the fix. */
  async getActivePromotions(limit = 6): Promise<ActivePromotion[]> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('get_active_promotions', { p_limit: limit });
      if (error || !Array.isArray(data)) return [];
      return data as ActivePromotion[];
    } catch {
      return [];
    }
  },

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

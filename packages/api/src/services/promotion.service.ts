import { getSupabaseClient } from '../client';
import { AppError } from '../errors';

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
  /**
   * 00519: false = private code (influencer / partner). Excluded from
   * `get_active_promotions` (home feed) and from the publish broadcast.
   * Still fully redeemable by whoever was given the code.
   */
  is_public: boolean;
  /** 00641: true while a promotion marketing created or edited waits for an admin to turn it on. */
  pending_approval?: boolean;
  /** 00641: the admin who turned it on, and when. */
  approved_by?: string | null;
  approved_at?: string | null;
  /**
   * 00641: counts changes to what the promotion offers; only the database writes it. An admin
   * approves the revision they saw (`approve`), so an edit made meanwhile is not switched on.
   */
  revision?: number;
  created_by: string | null;
  created_at: string;
}

// current_uses / created_at are server/DB-owned. `created_by` IS accepted on
// create — the service stamps it from the session (it used to be left NULL,
// so no admin-created promo had an author on record).
export type CreatePromotionInput = Omit<
  Promotion,
  | 'id'
  | 'current_uses'
  | 'created_at'
  | 'created_by'
  | 'pending_approval'
  | 'approved_by'
  | 'approved_at'
  | 'revision'
>;

/**
 * Columns added by migrations that may not be applied yet. On a
 * `column … does not exist` / schema-cache error we retry without them
 * (canonical column-missing retry) so the admin can still save.
 */
const TOLERATED_COLUMNS = ['is_public', 'first_ride_only'] as const;

function isMissingColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String((err as { message?: string })?.message ?? '');
  return (
    /schema cache/i.test(msg) ||
    TOLERATED_COLUMNS.some((c) => new RegExp(`column .*${c}|${c}.* does not exist`, 'i').test(msg))
  );
}

/** `promotions.revision` (00641) is not there yet: PostgREST passes Postgres' 42703 through. */
function isMissingRevisionError(err: unknown): boolean {
  const e = (err ?? {}) as { code?: string; message?: string };
  const msg = String(e.message ?? '');
  return /revision/i.test(msg) && (e.code === '42703' || /does not exist|schema cache/i.test(msg));
}

function stripTolerated<T extends Record<string, unknown>>(payload: T): T {
  const out = { ...payload };
  for (const c of TOLERATED_COLUMNS) delete out[c];
  return out;
}

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
    // Stamp the author. `created_by` was never sent, so every promo created
    // from the admin panel landed with a NULL author and no audit trail of
    // who published a given influencer code.
    const { data: auth } = await supabase.auth.getUser();
    const body: Record<string, unknown> = { ...payload, created_by: auth?.user?.id ?? null };

    const insert = (b: Record<string, unknown>) =>
      supabase.from('promotions').insert(b).select().single();

    let { data, error } = await insert(body);
    if (error && isMissingColumnError(error)) {
      ({ data, error } = await insert(stripTolerated(body)));
    }
    if (error) throw error;
    return data as Promotion;
  },

  async update(id: string, updates: Partial<Promotion>): Promise<void> {
    const supabase = getSupabaseClient();
    const patch = (u: Record<string, unknown>) =>
      supabase.from('promotions').update(u).eq('id', id);

    let { error } = await patch(updates as Record<string, unknown>);
    if (error && isMissingColumnError(error)) {
      ({ error } = await patch(stripTolerated(updates as Record<string, unknown>)));
    }
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

  /**
   * An admin turns on the promotion they reviewed (00641). It only matches the revision they saw
   * and only while it is still off, so an edit made in the meantime (a new revision) or someone
   * else's activation updates nothing, and this throws `PROMOTION_CHANGED` (409, not 401/403:
   * `getErrorMessage` reads those as an expired session). Until 00641 adds the column it falls
   * back to a plain activation, which is what the panel did before.
   */
  async approve(id: string, revision: number): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('promotions')
      .update({ is_active: true })
      .eq('id', id)
      .eq('revision', revision)
      .eq('is_active', false)
      .select('id');
    if (error && isMissingRevisionError(error)) {
      await promotionService.setActive(id, true);
      return;
    }
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new AppError(
        `promotion ${id} changed since it was loaded (revision ${revision})`,
        'PROMOTION_CHANGED',
        409,
      );
    }
  },

  async remove(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('promotions')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },

  /**
   * How many promotions marketing left waiting for an admin (00641). 0 when the column does
   * not exist yet or the query fails: it only drives a menu dot and a notice.
   */
  async countPendingApproval(): Promise<number> {
    try {
      const supabase = getSupabaseClient();
      const { count, error } = await supabase
        .from('promotions')
        .select('id', { count: 'exact', head: true })
        .eq('pending_approval', true);
      if (error) return 0;
      return count ?? 0;
    } catch {
      return 0;
    }
  },
};

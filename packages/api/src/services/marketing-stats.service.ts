// ============================================================
// TriciGo — Marketing Stats Service
// Per-code performance for the admin "Rendimiento de códigos"
// screen. Aggregates client-side over the same tables the admin
// already reads directly (rides / referrals / promotions) — no
// dedicated RPC, mirroring the `funnel` page and getReferralStats.
//
// Tolerant by design: every method returns [] on any error so the
// dashboard never crashes if a table/column isn't reachable yet
// (same pattern as promotionService.getActivePromotions).
// ============================================================

import { getSupabaseClient } from '../client';
import type { PromotionType } from './promotion.service';

/** One row per promo code: lifetime redemptions + completed-ride outcomes. */
export interface PromoCodePerformance {
  id: string;
  code: string;
  type: PromotionType;
  discount_percent: number | null;
  discount_fixed_cup: number | null;
  is_active: boolean;
  valid_from: string;
  valid_until: string | null;
  /** Slots claimed (promotions.current_uses) — net of cancellations. */
  redemptions: number;
  /** Rides completed with this code. */
  completed: number;
  /** Distinct customers on completed rides. */
  unique_users: number;
  /**
   * Promo discount granted on completed rides (CUP). Excludes the
   * shared-ride discount, which also lives in `rides.discount_amount_cup`
   * but is not a promo cost (mig 00347).
   */
  discount_given_cup: number;
  /** Amount actually charged on those completed rides, i.e. AFTER the discount (CUP). */
  revenue_cup: number;
}

/** One row per influencer (referrer): their referral code + conversion. */
export interface ReferralCodePerformance {
  referrer_id: string;
  code: string;
  invited: number;
  rewarded: number;
  pending: number;
  invalidated: number;
  /** Bonus actually paid out on rewarded referrals (CUP). */
  bonus_paid_cup: number;
}

interface PromoRow {
  id: string;
  code: string;
  type: PromotionType;
  discount_percent: number | null;
  discount_fixed_cup: number | null;
  is_active: boolean;
  valid_from: string;
  valid_until: string | null;
  current_uses: number | null;
}

interface RidePromoRow {
  promo_code_id: string | null;
  status: string;
  discount_amount_cup: number | null;
  shared_ride_discount_cup: number | null;
  final_fare_cup: number | null;
  customer_id: string | null;
}

/**
 * PostgREST caps an unbounded `select()` at 1000 rows and returns them
 * without a word — the promo/referral totals would silently plateau once a
 * campaign crossed that mark and read as "we stopped growing". Page through
 * with `.range()` until a short page comes back.
 */
const PAGE = 1000;
const MAX_PAGES = 50; // 50k rows — a runaway-loop backstop, not a real ceiling.

async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await build(page * PAGE, (page + 1) * PAGE - 1);
    if (error || !Array.isArray(data)) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
}

interface ReferralRow {
  referrer_id: string;
  code: string | null;
  status: string;
  bonus_amount: number | null;
}

export const marketingStatsService = {
  /**
   * Per-promo-code performance. Returns EVERY promo (even with zero
   * redemptions) so a code is visible before its first use.
   */
  async getPromoCodePerformance(): Promise<PromoCodePerformance[]> {
    try {
      const supabase = getSupabaseClient();
      const [promoRes, rides] = await Promise.all([
        supabase
          .from('promotions')
          .select(
            'id,code,type,discount_percent,discount_fixed_cup,is_active,valid_from,valid_until,current_uses',
          )
          .order('created_at', { ascending: false }),
        fetchAllRows<RidePromoRow>((from, to) =>
          supabase
            .from('rides')
            .select(
              'promo_code_id,status,discount_amount_cup,shared_ride_discount_cup,final_fare_cup,customer_id',
            )
            .not('promo_code_id', 'is', null)
            .order('created_at', { ascending: true })
            .range(from, to),
        ),
      ]);

      if (promoRes.error || !Array.isArray(promoRes.data)) return [];
      const promos = promoRes.data as PromoRow[];

      type Agg = { completed: number; discount: number; revenue: number; users: Set<string> };
      const byPromo = new Map<string, Agg>();
      for (const r of rides) {
        if (r.status !== 'completed' || !r.promo_code_id) continue;
        let agg = byPromo.get(r.promo_code_id);
        if (!agg) {
          agg = { completed: 0, discount: 0, revenue: 0, users: new Set<string>() };
          byPromo.set(r.promo_code_id, agg);
        }
        agg.completed += 1;
        // discount_amount_cup = promo + shared-ride (mig 00347). Only the
        // promo part is a campaign cost.
        agg.discount += Math.max(
          (r.discount_amount_cup ?? 0) - (r.shared_ride_discount_cup ?? 0),
          0,
        );
        agg.revenue += r.final_fare_cup ?? 0;
        if (r.customer_id) agg.users.add(r.customer_id);
      }

      return promos.map((p) => {
        const agg = byPromo.get(p.id);
        return {
          id: p.id,
          code: p.code,
          type: p.type,
          discount_percent: p.discount_percent,
          discount_fixed_cup: p.discount_fixed_cup,
          is_active: p.is_active,
          valid_from: p.valid_from,
          valid_until: p.valid_until,
          redemptions: p.current_uses ?? 0,
          completed: agg?.completed ?? 0,
          unique_users: agg?.users.size ?? 0,
          discount_given_cup: agg?.discount ?? 0,
          revenue_cup: agg?.revenue ?? 0,
        };
      });
    } catch {
      return [];
    }
  },

  /**
   * Per-influencer referral performance, grouped by referrer. Sorted by
   * invited desc so the top ambassadors surface first.
   */
  async getReferralCodePerformance(): Promise<ReferralCodePerformance[]> {
    try {
      const supabase = getSupabaseClient();
      const rows = await fetchAllRows<ReferralRow>((from, to) =>
        supabase
          .from('referrals')
          .select('referrer_id,code,status,bonus_amount')
          .order('created_at', { ascending: true })
          .range(from, to),
      );
      if (rows.length === 0) return [];

      const byReferrer = new Map<string, ReferralCodePerformance>();
      for (const r of rows) {
        let agg = byReferrer.get(r.referrer_id);
        if (!agg) {
          agg = {
            referrer_id: r.referrer_id,
            code: r.code ?? '',
            invited: 0,
            rewarded: 0,
            pending: 0,
            invalidated: 0,
            bonus_paid_cup: 0,
          };
          byReferrer.set(r.referrer_id, agg);
        }
        if (!agg.code && r.code) agg.code = r.code;
        agg.invited += 1;
        if (r.status === 'rewarded') {
          agg.rewarded += 1;
          agg.bonus_paid_cup += r.bonus_amount ?? 0;
        } else if (r.status === 'pending') {
          agg.pending += 1;
        } else if (r.status === 'invalidated') {
          agg.invalidated += 1;
        }
      }

      return Array.from(byReferrer.values()).sort((a, b) => b.invited - a.invited);
    } catch {
      return [];
    }
  },
};

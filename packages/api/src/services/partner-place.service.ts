import { getSupabaseClient } from '../client';
import type { PartnerPlace, PartnerCoupon, CouponValidation } from '@tricigo/types';

/**
 * A partner place as the admin panel sees it — the public shape plus the two
 * things only an admin may know: the business's secret validation token and
 * how the deal is actually performing.
 *
 * Not in `@tricigo/types` on purpose: this is admin-only and arrives from
 * `admin_list_partner_places`, never from the passenger-facing RPCs.
 */
export interface AdminPartnerPlace {
  id: string;
  name: string;
  category: string;
  address: string | null;
  municipality: string | null;
  province: string | null;
  photo_url: string | null;
  benefit_title: string;
  benefit_description: string;
  terms: string | null;
  latitude: number;
  longitude: number;
  radius_m: number;
  coupon_ttl_minutes: number;
  cooldown_days: number;
  is_active: boolean;
  valid_until: string | null;
  phone: string | null;
  hours: string | null;
  /** The business's secret validation link segment: tricigo.com/v/<token>. */
  validation_token: string;
  created_at: string;
  issued_count: number;
  redeemed_count: number;
  redeemed_by_business_count: number;
}

export interface AdminPartnerPlaceInput {
  id?: string | null;
  name: string;
  category: string;
  latitude: number;
  longitude: number;
  benefit_title: string;
  benefit_description: string;
  terms?: string | null;
  photo_url?: string | null;
  address?: string | null;
  municipality?: string | null;
  province?: string | null;
  phone?: string | null;
  hours?: string | null;
  radius_m: number;
  coupon_ttl_minutes: number;
  cooldown_days: number;
  is_active: boolean;
  valid_until?: string | null;
}

/**
 * Partner places and the arrival coupons they issue.
 *
 * Read paths (`getNearby`, `getMyCoupons`) swallow errors and return [].
 * That is deliberate: the migrations ship to git before anyone applies them
 * to production, so the RPC is legitimately missing for a while. A missing
 * perk section is invisible; a crashing home screen is not.
 *
 * Write/verdict paths (`validateCode`, `redeemCode`, `redeemOwn`) throw.
 * The business-facing page must never render a green "VÁLIDO" because a
 * network error was quietly turned into an empty object.
 */
export const partnerPlaceService = {
  async getNearby(latitude: number, longitude: number, limit = 10): Promise<PartnerPlace[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_nearby_partner_places', {
      p_lat: latitude,
      p_lng: longitude,
      p_limit: limit,
    });
    if (error) return [];
    return (data ?? []) as PartnerPlace[];
  },

  async getMyCoupons(): Promise<PartnerCoupon[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_my_partner_coupons', {});
    if (error) return [];
    return (data ?? []) as PartnerCoupon[];
  },

  /** @param token the business's secret link segment from tricigo.com/v/<token> */
  async validateCode(token: string, code: string): Promise<CouponValidation> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('validate_partner_coupon', {
      p_token: token, p_code: code,
    });
    if (error) throw error;
    return data as CouponValidation;
  },

  /** @param token the business's secret link segment from tricigo.com/v/<token> */
  async redeemCode(token: string, code: string): Promise<CouponValidation> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('redeem_partner_coupon', {
      p_token: token, p_code: code,
    });
    if (error) throw error;
    return data as CouponValidation;
  },

  async redeemOwn(couponId: string): Promise<CouponValidation> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('redeem_own_partner_coupon', {
      p_coupon_id: couponId,
    });
    if (error) throw error;
    return data as CouponValidation;
  },

  // ── Admin ───────────────────────────────────────────────────────────
  // These throw: an admin staring at an empty table needs to know the call
  // failed, not silently believe there are no partner places.
  //
  // Both RPCs are SECURITY DEFINER and gated on is_admin(). adminList reaches
  // validation_token, which 00529 revoked from `authenticated` at the column
  // level — reading partner_places directly from the client cannot return it,
  // and that is intentional (see 00533).
  async adminList(): Promise<AdminPartnerPlace[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_list_partner_places', {});
    if (error) throw error;
    return (data ?? []) as AdminPartnerPlace[];
  },

  async adminUpsert(input: AdminPartnerPlaceInput): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_upsert_partner_place', {
      p_id: input.id ?? null,
      p_name: input.name,
      p_category: input.category,
      p_lat: input.latitude,
      p_lng: input.longitude,
      p_benefit_title: input.benefit_title,
      p_benefit_description: input.benefit_description,
      p_terms: input.terms || null,
      p_photo_url: input.photo_url || null,
      p_address: input.address || null,
      p_municipality: input.municipality || null,
      p_province: input.province || null,
      p_phone: input.phone || null,
      p_hours: input.hours || null,
      p_radius_m: input.radius_m,
      p_coupon_ttl_minutes: input.coupon_ttl_minutes,
      p_cooldown_days: input.cooldown_days,
      p_is_active: input.is_active,
      p_valid_until: input.valid_until || null,
    });
    if (error) throw error;
    return String(data);
  },
};

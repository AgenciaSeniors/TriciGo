import { getSupabaseClient } from '../client';
import type { PartnerPlace, PartnerCoupon, CouponValidation } from '@tricigo/types';

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
};

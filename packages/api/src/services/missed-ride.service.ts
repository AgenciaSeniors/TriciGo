// ============================================================
// TriciGo — people whose ride found no driver (00674)
//
// The panel's /missed-rides page: who to write to (admin_missed_riders), the apology coupon in use
// (admin_missed_ride_coupon) and the contact itself (ops_contact_missed_rider), which records who
// wrote and gives the person the coupon once per confirmed phone. Admins and operators only; the
// server checks. supabase/migrations/00674_missed_ride_apology_coupon.sql
// ============================================================

import { getSupabaseClient } from '../client';
import { AppError } from '../errors';
import { callOpsRpc, isMissingRpc } from './_ops-rpc';
import type { PromotionType } from './promotion.service';

/** A function the database does not have yet (00674 not applied). */
export const MISSED_RIDES_UNAVAILABLE = 'MISSED_RIDES_UNAVAILABLE';

export type MissedRiderView = 'pending' | 'contacted';
export type MissedRiderCouponStatus = 'none' | 'granted' | 'used' | 'unusable';
export type MissedRideCouponReason = 'no_coupon_available' | 'already_given' | 'coupon_used' | 'coupon_unusable';

export interface MissedRider {
  user_id: string;
  full_name: string | null;
  /** The confirmed phone, digits without "+", or null. */
  phone: string | null;
  failed_requests: number;
  last_failed_at: string | null;
  last_failed_ride_id: string | null;
  last_pickup: string | null;
  last_dropoff: string | null;
  /** No completed or disputed ride since the last request and an eligible account: still writable. */
  in_segment: boolean;
  contacts: number;
  last_contacted_at: string | null;
  last_contacted_by: string | null;
  coupon_status: MissedRiderCouponStatus;
  coupon_code: string | null;
  /** No coupon on this account, but its phone got one before (from another account). */
  phone_already_rewarded: boolean;
  /** A completed or disputed ride after the first contact. */
  rode_after_contact: boolean;
}

export interface MissedRideCoupon {
  id: string;
  code: string;
  type: PromotionType;
  discount_percent: number | null;
  discount_fixed_cup: number | null;
  valid_until: string | null;
  max_uses: number | null;
  current_uses: number;
}

export interface MissedRiderContact {
  phone: string;
  fullName: string | null;
  lastFailedAt: string;
  coupon: {
    code: string;
    type: PromotionType;
    discountPercent: number | null;
    discountFixedCup: number | null;
    validUntil: string | null;
  } | null;
  couponReason: MissedRideCouponReason | null;
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await getSupabaseClient().rpc(name, args);
  if (error) {
    if (isMissingRpc(error)) throw new AppError(`${name} is not deployed yet`, MISSED_RIDES_UNAVAILABLE, 503);
    throw error;
  }
  return data;
}

export const missedRideService = {
  /** `days` null = everything. Pending: the latest failure in the window; contacted: the latest contact. */
  async list(view: MissedRiderView, days: number | null): Promise<MissedRider[]> {
    const rows = ((await rpc('admin_missed_riders', { p_view: view, p_days: days })) ?? []) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as MissedRider),
      failed_requests: Number(r.failed_requests ?? 0),
      contacts: Number(r.contacts ?? 0),
    }));
  },

  /** The coupon an operator gives now, or null when there is no active one. */
  async currentCoupon(): Promise<MissedRideCoupon | null> {
    const c = (await rpc('admin_missed_ride_coupon', {})) as Record<string, unknown> | null;
    if (!c || typeof c.code !== 'string') return null;
    return {
      id: String(c.id),
      code: c.code,
      type: c.type as PromotionType,
      discount_percent: num(c.discount_percent),
      discount_fixed_cup: num(c.discount_fixed_cup),
      valid_until: (c.valid_until as string | null) ?? null,
      max_uses: num(c.max_uses),
      current_uses: Number(c.current_uses ?? 0),
    };
  },

  /**
   * Record that the caller is writing to this person and give them the coupon if they have none.
   * `expectedLastFailedAt` is the failure the list showed: missed_rider_changed if it moved.
   */
  async contact(userId: string, expectedLastFailedAt: string): Promise<MissedRiderContact> {
    const r = await callOpsRpc('ops_contact_missed_rider',
      { p_user_id: userId, p_expected_last_failed_at: expectedLastFailedAt }, MISSED_RIDES_UNAVAILABLE);
    const c = r.coupon as Record<string, unknown> | null | undefined;
    return {
      phone: String(r.phone),
      fullName: (r.full_name as string | null) ?? null,
      lastFailedAt: String(r.last_failed_at),
      coupon: c && typeof c.code === 'string'
        ? {
            code: c.code,
            type: c.type as PromotionType,
            discountPercent: num(c.discount_percent),
            discountFixedCup: num(c.discount_fixed_cup),
            validUntil: (c.valid_until as string | null) ?? null,
          }
        : null,
      couponReason: (r.coupon_reason as MissedRideCouponReason | null) ?? null,
    };
  },
};

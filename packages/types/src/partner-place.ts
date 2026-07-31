// ============================================================
// TriciGo — Partner places & arrival coupons (00529–00532)
// ============================================================
//
// An admin configures a partner business with coordinates and a perk. A
// passenger whose ride ends inside that business's radius earns a single-use
// coupon, redeemable at the counter. The business absorbs the perk — nothing
// here touches wallets or the ledger.

/** A partner business, as returned by get_nearby_partner_places(). */
export interface PartnerPlace {
  id: string;
  name: string;
  benefit_title: string;
  benefit_description: string;
  terms: string | null;
  photo_url: string | null;
  category: string;
  address: string | null;
  municipality: string | null;
  phone: string | null;
  hours: string | null;
  latitude: number;
  longitude: number;
  distance_m: number;
  has_active_coupon: boolean;
}

/** One live coupon held by the calling passenger. Shape of get_my_partner_coupons(). */
export interface PartnerCoupon {
  id: string;
  code: string;
  place_name: string;
  benefit_title: string;
  benefit_description: string;
  terms: string | null;
  photo_url: string | null;
  category: string;
  address: string | null;
  phone: string | null;
  hours: string | null;
  issued_at: string;
  expires_at: string;
}

/**
 * Every status the five RPCs in 00531 can emit — all nine of them.
 *
 * Verified by reading the migration rather than the design doc: each arm is a
 * `jsonb_build_object('status', ...)` that some code path actually returns.
 * Keep it that way. A status the SQL can produce but this union omits does not
 * fail loudly — the services cast the JSONB verdict, so the missing value sails
 * through at runtime and only bites the caller, who cannot write
 * `if (v.status === 'unavailable')` without tsc rejecting the comparison as
 * having no overlap. That pushes whoever hits it toward casting the check away
 * rather than handling the case.
 */
export type CouponValidationStatus =
  | 'valid' | 'used' | 'expired' | 'not_found' | 'rate_limited' | 'redeemed'
  // The URL's business token did not resolve. Distinct from not_found, which
  // means the token was good but that business never issued this code.
  | 'invalid_link'
  // The two below come only from redeem_own_partner_coupon — the "Ya lo usé"
  // fallback the passenger taps when the shop cannot open the validation page.
  // Neither is an error: 'unavailable' is the ordinary answer to a double-tap
  // or to tapping after the coupon expired or was already redeemed at the
  // counter, and it is the one the ticket screen most needs to distinguish.
  | 'unavailable'
  | 'unauthenticated';

export interface CouponValidation {
  status: CouponValidationStatus;
  place_name?: string;
  benefit_title?: string;
  terms?: string | null;
  customer?: string;
  arrived_at?: string;
  expires_at?: string;
  redeemed_at?: string;
}

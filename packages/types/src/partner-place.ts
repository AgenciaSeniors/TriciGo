// ============================================================
// TriciGo — Partner places & fare discounts (00558–00561)
// ============================================================
//
// An admin configures a partner business with coordinates and a discount
// percentage. A passenger whose ride ENDS there pays that much less, and sees
// the reduced price before confirming.
//
// The platform absorbs the discount out of its own commission — the driver is
// paid on the full fare via the subsidy in 00481. The discount is capped at the
// ride's effective commission, so the platform gives up commission but never
// puts in money of its own.
//
// Before 00558 this feature worked the other way round: the business absorbed
// the perk and handed it over as a coupon at the counter. That model, and every
// type it needed (PartnerCoupon, CouponValidation), is gone.

/** A partner business, as returned by get_nearby_partner_places(). */
export interface PartnerPlace {
  id: string;
  name: string;
  /** Percentage off the fare. Capped at the ride's commission when applied. */
  discount_percent: number;
  /** Optional one-liner under the name, e.g. "Panadería artesanal". */
  tagline: string | null;
  photo_url: string | null;
  category: string;
  address: string | null;
  municipality: string | null;
  phone: string | null;
  hours: string | null;
  latitude: number;
  longitude: number;
  distance_m: number;
}

/**
 * What the passenger would save by going to this destination.
 *
 * Shape of get_partner_discount_for_dropoff(). Display only — the amount that
 * actually gets charged is written server-side by
 * tg_rides_validate_promo_discount, which derives it from the ride's dropoff
 * and ignores anything the client sends. The two use the same formula and the
 * same cap, so what is shown is what is charged.
 *
 * `found: false` covers every "no discount here" case — outside every radius,
 * no fare estimate yet, or the RPC not applied to production yet. Callers only
 * need the one check.
 */
export interface PartnerDiscount {
  found: boolean;
  place_id?: string;
  place_name?: string;
  discount_percent?: number;
  discount_cup?: number;
}

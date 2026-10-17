// ============================================================
// Signup code promotions (00665): a promotion linked to the code a person
// registered with. The server applies it to their next ride without a code;
// these rules decide what the booking screens show before that.
// ============================================================

function normalize(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Whether the promo field holds the signup promotion's code.
 * `signupPromoCode` is the linked promotion's code (`promotions.code`, what goes
 * in the promo field), not the signup code the person registered with; null when
 * there is none.
 */
export function isSignupPromoCode(promoCode: string, signupPromoCode: string | null): boolean {
  if (!signupPromoCode?.trim()) return false;
  const typed = normalize(promoCode);
  return typed !== '' && typed === normalize(signupPromoCode);
}

/**
 * The code to put in an empty promo field, or null to leave the field as it is.
 * `signupPromoCode` is the linked promotion's code (`promotions.code`, what goes
 * in the promo field), not the signup code the person registered with; null when
 * there is none.
 */
export function signupPromoPrefill(currentCode: string, signupPromoCode: string | null): string | null {
  if (!signupPromoCode?.trim() || currentCode.trim() !== '') return null;
  return signupPromoCode;
}

export type SignupPromoAction = 'validate' | 'clear' | 'none';

export interface SignupPromoState {
  /** What the promo field holds. */
  promoCode: string;
  /**
   * The linked promotion's code (`promotions.code`, what goes in the promo
   * field), not the signup code the person registered with; null when there is
   * none.
   */
  signupPromoCode: string | null;
  /**
   * A validation result is on screen. Callers must set one after ANY attempt,
   * failed or thrown included; if it stays false after a failure, 'validate'
   * repeats.
   */
  hasResult: boolean;
  validating: boolean;
  /** The fare of the selected service, in CUP. */
  fareCup: number;
  /** A passenger ride the person pays: not a delivery, no company account. */
  eligible: boolean;
}

/**
 * What to do with the signup code without a tap. The server applies it only to
 * a passenger ride the person pays, so the screens validate it only for those,
 * and clear its result when the ride stops being one (the app would otherwise
 * send the promotion with a delivery or a company ride). A different code the
 * person typed is never touched; the signup code's result is cleared on rides
 * it doesn't apply to, even if the person typed it.
 */
export function signupPromoAction(s: SignupPromoState): SignupPromoAction {
  if (s.validating || !isSignupPromoCode(s.promoCode, s.signupPromoCode)) return 'none';
  if (!s.eligible) return s.hasResult ? 'clear' : 'none';
  if (!s.hasResult && s.fareCup > 0) return 'validate';
  return 'none';
}

export type PromotionLinkStatus = 'active' | 'pending' | 'paused' | 'scheduled' | 'expired' | 'exhausted';

export interface PromotionLinkInput {
  is_active: boolean;
  pending_approval?: boolean | null;
  valid_from: string | null;
  valid_until: string | null;
  max_uses: number | null;
  current_uses: number;
}

/**
 * Whether a promotion linked to a signup code applies now, and if not, why.
 * Mirrors the promotion-level checks of get_my_signup_promotion (00665) and
 * validate_promo_code (00482); the per-person checks (already used, phone claim,
 * first_ride_only) are not part of it. Uses the device clock.
 */
export function promotionLinkStatus(p: PromotionLinkInput, now: Date = new Date()): PromotionLinkStatus {
  if (!p.is_active) return p.pending_approval ? 'pending' : 'paused';
  const t = now.getTime();
  if (p.valid_from && new Date(p.valid_from).getTime() > t) return 'scheduled';
  if (p.valid_until && new Date(p.valid_until).getTime() <= t) return 'expired';
  if (p.max_uses != null && p.current_uses >= p.max_uses) return 'exhausted';
  return 'active';
}

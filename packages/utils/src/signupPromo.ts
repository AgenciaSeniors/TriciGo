// ============================================================
// Signup code promotions (00665): a promotion linked to the code a person
// registered with. The server applies it to their next ride without a code;
// these rules decide what the booking screens show before that.
// ============================================================

function normalize(code: string): string {
  return code.trim().toUpperCase();
}

/** Whether the promo field holds the signup promotion's code. */
export function isSignupPromoCode(promoCode: string, signupPromoCode: string | null): boolean {
  return !!signupPromoCode && normalize(promoCode) !== '' && normalize(promoCode) === normalize(signupPromoCode);
}

/** The code to put in an empty promo field, or null to leave the field as it is. */
export function signupPromoPrefill(currentCode: string, signupPromoCode: string | null): string | null {
  if (!signupPromoCode || currentCode.trim() !== '') return null;
  return signupPromoCode;
}

export type SignupPromoAction = 'validate' | 'clear' | 'none';

export interface SignupPromoState {
  /** What the promo field holds. */
  promoCode: string;
  /** The signup promotion's code, or null when there is none. */
  signupPromoCode: string | null;
  /** A validation result (valid or not) is on screen. */
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
 * send the promotion with a delivery or a company ride). A code the person
 * typed is never touched.
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

/** Whether a promotion linked to a signup code applies today, and if not, why. */
export function promotionLinkStatus(p: PromotionLinkInput, now: Date = new Date()): PromotionLinkStatus {
  if (!p.is_active) return p.pending_approval ? 'pending' : 'paused';
  const t = now.getTime();
  if (p.valid_from && new Date(p.valid_from).getTime() > t) return 'scheduled';
  if (p.valid_until && new Date(p.valid_until).getTime() <= t) return 'expired';
  if (p.max_uses != null && p.current_uses >= p.max_uses) return 'exhausted';
  return 'active';
}

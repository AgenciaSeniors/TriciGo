// ============================================================
// TriciGo — Promotion & Referral Types
// ============================================================

import type { PromotionType, ReferralStatus } from './enums';

export interface Promotion {
  id: string;
  code: string;
  type: PromotionType;
  /** For percentage_discount: 0-100 */
  discount_percent: number | null;
  /** For fixed_discount / bonus_credit: amount in centavos */
  discount_fixed_cup: number | null;
  max_uses: number | null;
  current_uses: number;
  is_active: boolean;
  valid_from: string;
  valid_until: string | null;
  created_by: string;
  created_at: string;
}

export interface Referral {
  id: string;
  referrer_id: string;
  referee_id: string;
  code: string;
  status: ReferralStatus;
  /** Bonus amount in centavos for the referrer */
  bonus_amount: number;
  transaction_id: string | null;
  created_at: string;
  rewarded_at: string | null;
}

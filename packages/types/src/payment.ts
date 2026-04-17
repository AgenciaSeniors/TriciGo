// ============================================================
// TriciGo — Payment Intent Types
// Tracks payment lifecycle for wallet recharges and direct
// ride payments via Stripe.
// ============================================================

export type PaymentIntentType = 'recharge' | 'ride_payment';

export type PaymentIntentStatus =
  | 'created'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'refunded';

/** Payment provider used for this intent */
export type PaymentProvider = 'stripe' | 'tropipay';

export interface PaymentIntent {
  id: string;
  user_id: string;

  /** Stripe PaymentIntent ID */
  stripe_payment_intent_id?: string | null;
  /** Payment provider used ('stripe' or legacy 'tropipay') */
  payment_provider: PaymentProvider | null;
  /** Full payment URL (legacy, not used with Stripe Elements) */
  payment_url: string | null;
  /** Short URL for sharing (legacy) */
  short_url: string | null;

  /** Amount in CUP whole units (1 TRC = 1 CUP) */
  amount_cup: number;
  /** Equivalent USD amount at creation time */
  amount_usd: number | null;
  /** USD/CUP exchange rate used at creation */
  exchange_rate: number | null;
  /** Fee charged in USD (e.g., $2 fixed) */
  fee_usd: number | null;

  status: PaymentIntentStatus;

  /** Optional link to a wallet_recharge_requests row */
  recharge_request_id: string | null;
  /** Set when payment completes (links to ledger_transactions) */
  transaction_id: string | null;

  /** Raw webhook payload */
  webhook_payload: Record<string, unknown> | null;
  error_message: string | null;

  /** Intent type: recharge (wallet) or ride_payment (direct ride payment) */
  intent_type: PaymentIntentType;
  /** Linked ride ID (only for ride_payment intents) */
  ride_id: string | null;
  /** Corporate account (for corporate recharges) */
  corporate_account_id: string | null;

  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Response from create-stripe-payment-intent edge function */
export interface CreateStripeIntentResponse {
  ok: true;
  clientSecret: string;
  intentId: string;
  amountUsd: number;
  amountCup: number;
  feeUsd: number;
  exchangeRate: number;
  publishableKey: string;
}

/** Stripe recharge config from platform_config */
export interface StripeRechargeConfig {
  enabled: boolean;
  publishableKey: string;
  minRechargeCup: number;
  maxRechargeCup: number;
  feeUsd: number;
  feeType: 'fixed' | 'percentage';
}

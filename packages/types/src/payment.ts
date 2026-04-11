// ============================================================
// TriciGo — Payment Intent Types
// Tracks payment lifecycle for wallet recharges and direct
// ride payments.
// TODO: Replace with Stripe PaymentIntent creation
// ============================================================

export type PaymentIntentType = 'recharge' | 'ride_payment';

export type PaymentIntentStatus =
  | 'created'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'refunded';

export interface PaymentIntent {
  id: string;
  user_id: string;

  /** Stripe PaymentIntent ID (will replace legacy payment provider) */
  stripe_payment_intent_id?: string | null;
  /** Full payment URL */
  payment_url: string | null;
  /** Short URL for sharing */
  short_url: string | null;

  /** Amount in CUP centavos */
  amount_cup: number;
  /** Equivalent USD amount at creation time */
  amount_usd: number | null;
  /** USD/CUP exchange rate used at creation */
  exchange_rate: number | null;

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

  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

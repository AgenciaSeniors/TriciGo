// ============================================================
// TriciGo — Payment Intent Types
// Tracks TropiPay payment link lifecycle for wallet recharges
// and direct ride payments. Each intent maps to a single
// TropiPay payment card.
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

  /** TropiPay's internal payment card ID */
  tropipay_id: string | null;
  /** Full payment URL from TropiPay */
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

  /** Our unique reference sent to TropiPay (idempotency) */
  tropipay_reference: string;
  /** Raw response from TropiPay API */
  tropipay_response: Record<string, unknown> | null;
  /** Raw webhook payload from TropiPay */
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

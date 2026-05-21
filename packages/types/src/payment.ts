// ============================================================
// TriciGo — Payment Intent Types
// Tracks payment lifecycle for wallet recharges via the active
// payment provider. NETOPIA Payments is the sole live provider
// after the 2026-05-20 cutover; Stripe and TropiPay remain in the
// PaymentProvider union as historical-data values so old rows
// in payment_intents continue to type-check, but no new code path
// creates them. Removing them from the union is a follow-up once
// migration that backfills historical rows lands.
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

/**
 * Payment provider used for this intent.
 *
 * - `netopia`: the only provider used for new recharges (post 2026-05-20 cutover).
 * - `stripe` / `tropipay`: legacy values preserved so historical
 *   payment_intents rows still type-check. No code path creates these.
 * - `euplatesc`: reserved for future Phase D3.
 */
export type PaymentProvider = 'netopia' | 'euplatesc' | 'stripe' | 'tropipay';

export interface PaymentIntent {
  id: string;
  user_id: string;

  /**
   * External provider transaction id. Historically named for Stripe;
   * NETOPIA stores its `ntpID` here. A follow-up rename to
   * `provider_intent_id` is documented in PAYMENT_PROVIDER_CONTRACT.md.
   */
  stripe_payment_intent_id?: string | null;
  /** Which payment provider produced this row. */
  payment_provider: PaymentProvider | null;
  /** Full payment URL (legacy column kept for historical rows). */
  payment_url: string | null;
  /** Short URL for sharing (legacy column kept for historical rows). */
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

// ============================================================
// Provider-agnostic recharge contract (Phase D1)
// See docs/payment-processor/PAYMENT_PROVIDER_CONTRACT.md.
// ============================================================

/** Provider-agnostic input to create a wallet recharge intent. */
export interface RechargeIntentRequest {
  /** Which payment processor to route this recharge through. */
  provider: PaymentProvider;
  userId: string;
  amountCup: number;
  /** 'customer' credits the rider wallet; 'driver_quota' the driver commission credit. */
  rechargeType?: 'customer' | 'driver_quota';
  corporateAccountId?: string;
  /** Phase B6: basic device fingerprint of the payer's browser, for fraud analysis. */
  deviceFingerprint?: string;
  /**
   * Optional override of the URL the processor redirects the user to after
   * settlement. The edge function appends `?intent=<id>` server-side. Used by
   * mobile apps to send the user back into the app via universal link
   * (e.g. `https://tricigo.com/app/client/wallet`) or custom scheme
   * (`tricigo://wallet`). Whitelisted prefixes only — see the edge function.
   * When omitted, the edge function defaults to the web wallet
   * (`https://tricigo.com/wallet`).
   */
  returnUrl?: string;
}

/**
 * Provider-agnostic result of creating a recharge intent. The common
 * fields are always present; the provider-specific fields are optional
 * — redirect-based providers (NETOPIA, EuPlatesc) populate `redirectUrl`.
 */
export interface RechargeIntentResult {
  ok: true;
  provider: PaymentProvider;
  /** TriciGo payment_intents row id. */
  intentId: string;
  amountCup: number;
  amountUsd: number;
  feeUsd: number;
  exchangeRate: number;
  /** Redirect-based providers (NETOPIA, EuPlatesc): URL to send the payer to. */
  redirectUrl?: string;
  /** Echoed environment ('sandbox' | 'live') for diagnostics. */
  environment?: 'sandbox' | 'live';
}

/** Provider-agnostic recharge configuration from platform_config. */
export interface PaymentProviderConfig {
  provider: PaymentProvider;
  enabled: boolean;
  /** Publishable / public key, when the provider uses one. */
  publishableKey: string;
  minRechargeCup: number;
  maxRechargeCup: number;
  feeUsd: number;
  feeType: 'fixed' | 'percentage';
}

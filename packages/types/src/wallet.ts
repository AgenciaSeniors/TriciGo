// ============================================================
// TriciGo — Wallet & Ledger Types
// Double-entry ledger model: every financial operation creates
// immutable entries (debit + credit pairs). Balance is derived,
// never directly mutated.
//
// Currency: 1 TRC = 1 CUP (whole units, no centavos).
// USD conversion via eltoque exchange rate.
// ============================================================

import type {
  LedgerEntryType,
  LedgerTransactionStatus,
  WalletAccountType,
} from './enums';

export interface WalletAccount {
  id: string;
  user_id: string;
  account_type: WalletAccountType;
  /** Current available balance in TRC whole units (1 TRC = 1 CUP) */
  balance: number;
  /** Amount currently held/locked (e.g., during active ride) */
  held_balance: number;
  currency: 'TRC';
  is_active: boolean;
  is_frozen: boolean;
  frozen_reason: string | null;
  frozen_at: string | null;
  frozen_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerTransaction {
  id: string;
  /** Caller-supplied key to prevent duplicate operations */
  idempotency_key: string;
  type: LedgerEntryType;
  status: LedgerTransactionStatus;
  /** What business entity this relates to (e.g., 'ride', 'transfer') */
  reference_type: string | null;
  /** ID of the referenced entity */
  reference_id: string | null;
  description: string;
  metadata: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
}

export interface LedgerEntry {
  id: string;
  transaction_id: string;
  account_id: string;
  /** Positive = credit, Negative = debit. In TRC whole units. */
  amount: number;
  /** Account balance after this entry was applied */
  balance_after: number;
  created_at: string;
}

export interface WalletTransfer {
  id: string;
  from_user_id: string;
  to_user_id: string;
  /** Amount in TRC whole units */
  amount: number;
  transaction_id: string;
  note: string | null;
  created_at: string;
}

export interface WalletRechargeRequest {
  id: string;
  user_id: string;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  processed_by: string | null;
  processed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export interface WalletRedemption {
  id: string;
  driver_id: string;
  amount: number;
  // BUG-043 fix: match DB enum (redemption_status)
  status: 'requested' | 'approved' | 'processed' | 'rejected';
  processed_by: string | null;
  processed_at: string | null;
  rejection_reason: string | null;
  requested_at: string;
  created_at: string;
}

export type FraudAlertType =
  | 'unusual_transfer'
  | 'rapid_recharges'
  | 'suspicious_cancellations'
  | 'velocity_anomaly';

export type FraudSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface FraudAlert {
  id: string;
  user_id: string;
  alert_type: FraudAlertType;
  severity: FraudSeverity;
  details: Record<string, unknown> | null;
  resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

/** Summary view for displaying wallet info in the UI */
export interface WalletSummary {
  available_balance: number;
  held_balance: number;
  total_earned: number;
  total_spent: number;
  currency: 'TRC';
}

/** Driver quota status for the quota system */
export interface DriverQuotaStatus {
  /** Current quota balance in TRC (= CUP) */
  balance: number;
  /** Total amount ever recharged into quota */
  total_recharged: number;
  /** Whether the low-quota warning is active */
  warning_active: boolean;
  /** Remaining grace trips (when quota = 0) */
  grace_trips_remaining: number;
  /** Whether the driver is blocked from accepting trips */
  blocked: boolean;
  /** The deduction rate (e.g., 0.15 = 15%) */
  deduction_rate: number;
}

// ============================================================
// TriciGo — Wallet & Ledger Types
// Double-entry ledger model: every financial operation creates
// immutable entries (debit + credit pairs). Balance is derived,
// never directly mutated.
// ============================================================

import type {
  LedgerEntryType,
  LedgerTransactionStatus,
  RedemptionStatus,
  WalletAccountType,
} from './enums';

export interface WalletAccount {
  id: string;
  user_id: string;
  account_type: WalletAccountType;
  /** Current available balance in centavos (100 = 1 TriciCoin) */
  balance: number;
  /** Amount currently held/locked (e.g., during active ride) */
  held_balance: number;
  currency: 'TRC';
  is_active: boolean;
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
  /** Positive = credit, Negative = debit. In centavos. */
  amount: number;
  /** Account balance after this entry was applied */
  balance_after: number;
  created_at: string;
}

export interface WalletTransfer {
  id: string;
  from_account_id: string;
  to_account_id: string;
  /** Amount in centavos */
  amount: number;
  transaction_id: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

export interface WalletRedemption {
  id: string;
  driver_id: string;
  /** Amount to redeem in centavos */
  amount: number;
  status: RedemptionStatus;
  transaction_id: string | null;
  requested_at: string;
  processed_at: string | null;
  processed_by: string | null;
  rejection_reason: string | null;
}

/** Summary view for displaying wallet info in the UI */
export interface WalletSummary {
  available_balance: number;
  held_balance: number;
  total_earned: number;
  total_spent: number;
  currency: 'TRC';
}

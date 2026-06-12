/**
 * Ledger display helpers.
 */

export interface LedgerEntryAmount {
  account_id?: string | null;
  amount: number;
}

/**
 * Net signed amount a single ledger transaction has on ONE wallet account.
 *
 * A ledger transaction can touch the same account more than once (a mixed-ride
 * payment credits the wallet portion AND debits the platform commission in one
 * transaction) or span several accounts (a tip debits the rider and credits the
 * driver). The wallet UI used to read `entries[0].amount` blindly, which showed
 * the wrong row/sign — e.g. a tip the driver RECEIVED rendered as a negative
 * "Ajuste −778" (the rider's debit entry), and a mixed ride showed "+0" (the
 * wallet portion) while hiding the commission. Summing only the entries that
 * belong to `accountId` gives the true net effect on that account.
 *
 * Falls back to the first entry's amount when `accountId` is unknown or no entry
 * matches it — single-account transactions are unaffected.
 */
export function signedLedgerAmountForAccount(
  entries: LedgerEntryAmount[] | undefined | null,
  accountId: string | undefined | null,
): number {
  const list = entries ?? [];
  if (accountId) {
    const mine = list.filter((e) => e.account_id === accountId);
    if (mine.length > 0) {
      return mine.reduce((sum, e) => sum + (e.amount ?? 0), 0);
    }
  }
  return list[0]?.amount ?? 0;
}

/**
 * Semantic category of a wallet transaction, decoupled from the raw
 * `ledger_entry_type` enum. The wallet history surfaces (client, driver, web)
 * each kept their own type→label/icon maps, which drifted and got direction
 * wrong: a GIFT is stored as one `transfer_out` transaction for BOTH parties,
 * so the recipient (a credit) was mislabelled "Transferencia enviada"; TIPS
 * post as `adjustment` + `reference_type='tip'` and were shown as "Ajuste".
 * Centralising the classification here keeps every surface in sync.
 */
export type WalletTxnKind =
  | 'recharge' | 'ride' | 'commission' | 'gift' | 'tip'
  | 'penalty' | 'bonus' | 'refund' | 'adjustment' | 'transfer'
  | 'insurance';

/** Minimal shape of a ledger transaction needed to classify it. */
export interface ClassifiableTxn {
  type: string;
  reference_type?: string | null;
  metadata?: Record<string, unknown> | null;
  ledger_entries?: LedgerEntryAmount[] | null;
}

export interface WalletTxnView {
  /** Net signed effect on the viewer's account (see signedLedgerAmountForAccount). */
  signedAmount: number;
  isCredit: boolean;
  isZero: boolean;
  kind: WalletTxnKind;
  /** From the viewer's perspective: money in (credit), out (debit), or neutral (zero). */
  direction: 'in' | 'out' | 'neutral';
}

/**
 * Classify a ledger transaction from the perspective of ONE account.
 *
 * `direction`/`isCredit` come from the net amount on that account — so the same
 * `transfer_out` gift reads as 'in' for the recipient and 'out' for the sender.
 * Detection order matters (reference_type beats type for tips/gifts/penalties).
 */
export function classifyWalletTxn(
  tx: ClassifiableTxn,
  accountId: string | undefined | null,
): WalletTxnView {
  const signedAmount = signedLedgerAmountForAccount(tx.ledger_entries, accountId);
  const isZero = signedAmount === 0;
  const isCredit = signedAmount > 0;
  const direction: WalletTxnView['direction'] = isZero ? 'neutral' : isCredit ? 'in' : 'out';

  const ref = tx.reference_type ?? null;
  const metaKind =
    tx.metadata && typeof tx.metadata === 'object'
      ? (tx.metadata as Record<string, unknown>).kind
      : undefined;
  const type = tx.type;

  let kind: WalletTxnKind;
  if (ref === 'tip') {
    kind = 'tip';
  } else if (
    type === 'transfer_in' ||
    type === 'transfer_out' ||
    ref === 'wallet_transfer' ||
    metaKind === 'gift'
  ) {
    kind = 'gift';
  } else if (ref === 'cancellation_penalty') {
    kind = 'penalty';
  } else if (type === 'recharge') {
    kind = 'recharge';
  } else if (
    type === 'ride_payment' ||
    type === 'ride_hold' ||
    type === 'ride_hold_release' ||
    type === 'redemption'
  ) {
    kind = 'ride';
  } else if (type === 'commission') {
    kind = 'commission';
  } else if (type === 'promo_credit' || ref === 'referral') {
    kind = 'bonus';
  } else if (type === 'insurance_premium') {
    // Real live type (mig 00398) — fell through to 'transfer', which the web
    // labelled "Regalo enviado". The trip-insurance premium is its own thing.
    kind = 'insurance';
  } else if (type === 'refund') {
    // NETOPIA recharge refunds post with type='refund' (mig 00398) — they
    // also fell through to 'transfer'/"Regalo recibido".
    kind = 'refund';
  } else if (type === 'quota_purchase' || type === 'quota_deduction') {
    kind = 'adjustment';
  } else if (type === 'adjustment') {
    kind = isCredit ? 'refund' : 'adjustment';
  } else {
    kind = 'transfer';
  }

  return { signedAmount, isCredit, isZero, kind, direction };
}

/**
 * Shared Ionicons glyph name for a classified transaction (client + driver use
 * Ionicons; web renders no icon). Direction-aware for gifts/transfers so a
 * received gift shows an incoming arrow.
 */
export function walletTxnIcon(view: Pick<WalletTxnView, 'kind' | 'direction'>): string {
  switch (view.kind) {
    case 'recharge':
      return 'add-circle';
    case 'ride':
      return 'car';
    case 'commission':
      return 'trending-down';
    case 'gift':
    case 'transfer':
      return view.direction === 'in' ? 'arrow-down' : 'arrow-up';
    case 'tip':
      return 'heart';
    case 'penalty':
      return 'remove-circle';
    case 'bonus':
      return 'gift';
    case 'refund':
      return 'refresh';
    case 'insurance':
      return 'shield-checkmark';
    case 'adjustment':
    default:
      return 'swap-horizontal';
  }
}

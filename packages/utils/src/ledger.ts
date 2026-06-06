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

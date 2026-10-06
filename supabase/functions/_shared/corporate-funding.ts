// ============================================================
// Who may open a recharge for a corporate wallet.
//
// A recharge intent with corporate_account_id gets the corporate limits
// ($100–$10,000 per intent) and skips the per-user velocity check, and
// process_recharge_payment credits the corporate_cash wallet of the account's
// creator without looking at the account's status. Before 2026-10-06 the
// create-*-payment-intent functions took corporate_account_id from the
// request unchecked, so any user could register a pending corporate account
// (register_corporate_account) and use it to lift the $500 cap and the
// velocity limits that slow down stolen-card top-ups.
//
// The apps only offer the recharge to corporate admins of APPROVED accounts
// (corporateService lists approved ones), so that is the rule here too.
//
// Pure module with no remote imports, so packages/api's vitest runs its test.
// The EF supplies the facts from the database.
// ============================================================

export interface CorporateFundingFacts {
  /** corporate_accounts row, or null if the id does not exist. */
  account: { status: string; createdBy: string | null } | null;
  /** The caller has an active corporate_employees row with role 'admin' for the account. */
  callerIsActiveCorpAdmin: boolean;
  /** The caller is a platform admin or super_admin. */
  callerIsPlatformAdmin: boolean;
}

export type CorporateFundingVerdict = 'allowed' | 'not_found' | 'not_approved' | 'forbidden';

export function corporateFundingVerdict(callerId: string, f: CorporateFundingFacts): CorporateFundingVerdict {
  if (!f.account) return 'not_found';
  if (f.callerIsPlatformAdmin) return 'allowed';
  if (f.account.status !== 'approved') return 'not_approved';
  if (f.account.createdBy === callerId || f.callerIsActiveCorpAdmin) return 'allowed';
  return 'forbidden';
}

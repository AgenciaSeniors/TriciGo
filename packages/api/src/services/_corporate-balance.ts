// ============================================================
// TriciGo — the balance of the wallet that funds a company
// Shared by corporateService (client app, web) and walletService (panel).
// ============================================================

import { getSupabaseClient } from '../client';

export interface CorporateBalance {
  available: number;
  held: number;
}

function isMissingFunctionError(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '');
}

/**
 * A company's money is the corporate_cash wallet of its creator
 * (corporate_accounts.created_by): that is the wallet every server path
 * charges and credits. There is no wallet row under the company id.
 *
 * get_corporate_balance (00624) reads it for a platform admin or any admin of
 * the company, and answers 42501 to anyone else. Until 00624 is applied the
 * creator's wallet is read directly, which only its creator and platform
 * admins can do (wallet_accounts is own-or-admin). Throws the server's error.
 */
export async function readCorporateBalance(accountId: string): Promise<CorporateBalance> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('get_corporate_balance', { p_account_id: accountId });
  if (!error) {
    const row = (Array.isArray(data) ? data[0] : data) as Partial<CorporateBalance> | null | undefined;
    return { available: row?.available ?? 0, held: row?.held ?? 0 };
  }
  if (!isMissingFunctionError(error)) throw error;

  // corporate_accounts.id is the primary key and (user_id, account_type) is
  // unique, so each lookup matches at most one row.
  const { data: account, error: accountError } = await supabase
    .from('corporate_accounts')
    .select('created_by')
    .eq('id', accountId)
    .maybeSingle();
  if (accountError) throw accountError;
  const creator = (account as { created_by?: string } | null)?.created_by;
  if (!creator) return { available: 0, held: 0 };

  const { data: wallet, error: walletError } = await supabase
    .from('wallet_accounts')
    .select('balance, held_balance')
    .eq('user_id', creator)
    .eq('account_type', 'corporate_cash')
    .maybeSingle();
  if (walletError) throw walletError;
  const row = wallet as { balance?: number; held_balance?: number } | null;
  return { available: row?.balance ?? 0, held: row?.held_balance ?? 0 };
}

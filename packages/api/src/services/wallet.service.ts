// ============================================================
// TriciGo — Wallet Service
// Client-side wallet operations. Financial mutations happen
// server-side via Edge Functions for safety.
// ============================================================

import type {
  WalletAccount,
  LedgerTransaction,
  WalletSummary,
  WalletRechargeRequest,
  WalletTransfer,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const walletService = {
  /**
   * Get the wallet account for the current user.
   */
  async getAccount(userId: string): Promise<WalletAccount | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('account_type', 'customer_cash')
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data as WalletAccount | null;
  },

  /**
   * Get wallet summary (balance, held, totals) for display.
   */
  async getSummary(userId: string): Promise<WalletSummary> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .rpc('get_wallet_summary', { p_user_id: userId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row ?? {
      available_balance: 0,
      held_balance: 0,
      total_earned: 0,
      total_spent: 0,
      currency: 'TRC',
    }) as WalletSummary;
  },

  /**
   * Get transaction history for a wallet account.
   */
  async getTransactions(
    accountId: string,
    page = 0,
    pageSize = 20,
  ): Promise<LedgerTransaction[]> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from('ledger_transactions')
      .select(`
        *,
        ledger_entries!inner(account_id, amount)
      `)
      .eq('ledger_entries.account_id', accountId)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;
    return data as LedgerTransaction[];
  },

  /**
   * Get balance (read-only, derived from ledger).
   */
  async getBalance(userId: string): Promise<{ available: number; held: number }> {
    const account = await walletService.getAccount(userId);
    if (!account) return { available: 0, held: 0 };
    return {
      available: account.balance,
      held: account.held_balance,
    };
  },

  /**
   * Ensure a wallet account exists for the user. Creates one if missing.
   */
  async ensureAccount(
    userId: string,
    accountType = 'customer_cash',
  ): Promise<WalletAccount> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('ensure_wallet_account', {
      p_user_id: userId,
      p_type: accountType,
    });
    if (error) throw error;
    // RPC returns the account ID; fetch full account
    const account = await this.getAccount(userId);
    if (!account) throw new Error('Failed to ensure wallet account');
    return account;
  },

  /**
   * Request a wallet recharge (customer).
   */
  async requestRecharge(
    userId: string,
    amount: number,
  ): Promise<WalletRechargeRequest> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_recharge_requests')
      .insert({ user_id: userId, amount })
      .select()
      .single();
    if (error) throw error;
    return data as WalletRechargeRequest;
  },

  /**
   * Get recharge request history for a user.
   */
  async getRechargeRequests(userId: string): Promise<WalletRechargeRequest[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_recharge_requests')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as WalletRechargeRequest[];
  },

  // ==================== P2P TRANSFERS ====================

  /**
   * Transfer TriciCoin to another user via phone number.
   * Calls the transfer_wallet_p2p SECURITY DEFINER function.
   */
  async transferP2P(
    fromUserId: string,
    toUserId: string,
    amount: number,
    note?: string,
  ): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('transfer_wallet_p2p', {
      p_from_user_id: fromUserId,
      p_to_user_id: toUserId,
      p_amount: amount,
      p_note: note ?? null,
    });
    if (error) throw error;
    return data as string;
  },

  /**
   * Find a user by phone number (for transfer recipient).
   */
  async findUserByPhone(
    phone: string,
  ): Promise<{ id: string; full_name: string; phone: string } | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('find_user_by_phone', {
      p_phone: phone,
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row as { id: string; full_name: string; phone: string }) ?? null;
  },

  /**
   * Get P2P transfer history for a user.
   */
  async getTransfers(userId: string): Promise<WalletTransfer[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_transfers')
      .select('*')
      .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    return data as WalletTransfer[];
  },

  // ==================== CORPORATE WALLETS ====================

  /**
   * Get corporate wallet balance.
   * Reuses user_id column to store corporate_account_id.
   */
  async getCorporateBalance(
    corporateAccountId: string,
  ): Promise<{ available: number; held: number }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_accounts')
      .select('balance, held_balance')
      .eq('user_id', corporateAccountId)
      .eq('account_type', 'corporate_cash')
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return { available: 0, held: 0 };
    return { available: data.balance, held: data.held_balance };
  },

  /**
   * Ensure a corporate wallet account exists.
   */
  async ensureCorporateAccount(
    corporateAccountId: string,
  ): Promise<WalletAccount> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('ensure_wallet_account', {
      p_user_id: corporateAccountId,
      p_type: 'corporate_cash',
    });
    if (error) throw error;
    // Fetch the account
    const { data: account, error: fetchError } = await supabase
      .from('wallet_accounts')
      .select('*')
      .eq('user_id', corporateAccountId)
      .eq('account_type', 'corporate_cash')
      .single();
    if (fetchError) throw fetchError;
    return account as WalletAccount;
  },

  // ==================== PLATFORM CONFIG ====================

  /**
   * Get a value from the platform_config table.
   */
  async getConfigValue(key: string): Promise<string | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('platform_config')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    return data?.value != null ? String(data.value) : null;
  },
};

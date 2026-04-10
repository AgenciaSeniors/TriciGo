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
  DriverQuotaStatus,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { validate, rechargeSchema, transferP2PSchema } from '../schemas';
import { logger } from '@tricigo/utils';
import { NotFoundError } from '../errors';

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
    if (!account) throw new NotFoundError('WalletAccount');
    return account;
  },

  /**
   * Request a wallet recharge (customer).
   */
  async requestRecharge(
    userId: string,
    amount: number,
  ): Promise<WalletRechargeRequest> {
    const valid = validate(rechargeSchema, { userId, amount });
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_recharge_requests')
      .insert({ user_id: valid.userId, amount: valid.amount })
      .select()
      .single();
    if (error) throw error;
    logger.info('recharge_requested', { userId: valid.userId, amount: valid.amount });
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
    const valid = validate(transferP2PSchema, { fromUserId, toUserId, amount, note });
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('transfer_wallet_p2p', {
      p_from_user_id: valid.fromUserId,
      p_to_user_id: valid.toUserId,
      p_amount: valid.amount,
      p_note: valid.note ?? null,
    });
    if (error) throw error;
    logger.info('p2p_transfer', { from: valid.fromUserId, to: valid.toUserId, amount: valid.amount });
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

  // ==================== DRIVER QUOTA ====================

  /**
   * Get the driver's quota account.
   */
  async getDriverQuotaAccount(driverUserId: string): Promise<WalletAccount | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_accounts')
      .select('*')
      .eq('user_id', driverUserId)
      .eq('account_type', 'driver_quota')
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data as WalletAccount | null;
  },

  /**
   * Get full quota status for a driver (balance, warnings, grace, block).
   * Calls the get_driver_quota_status RPC.
   */
  async getQuotaStatus(driverUserId: string): Promise<DriverQuotaStatus> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_driver_quota_status', {
      p_driver_user_id: driverUserId,
    });
    if (error) throw error;
    const result = data as Record<string, unknown>;
    return {
      balance: Number(result.balance ?? 0),
      total_recharged: Number(result.total_recharged ?? 0),
      warning_active: Boolean(result.warning_active),
      grace_trips_remaining: Number(result.grace_trips_remaining ?? 0),
      blocked: Boolean(result.blocked),
      deduction_rate: Number(result.deduction_rate ?? 0.15),
    };
  },

  /**
   * Get quota balance only (lightweight read).
   */
  async getQuotaBalance(driverUserId: string): Promise<number> {
    const account = await this.getDriverQuotaAccount(driverUserId);
    return account?.balance ?? 0;
  },

  /**
   * Recharge driver quota via RPC.
   * Called after TropiPay payment confirmation.
   *
   * @param driverUserId - Driver's user ID
   * @param amount - Amount in TRC whole units (= CUP)
   * @param idempotencyKey - Optional key to prevent duplicate recharges
   */
  async rechargeQuota(
    driverUserId: string,
    amount: number,
    idempotencyKey?: string,
  ): Promise<{ balance: number; recharged: number }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('recharge_driver_quota', {
      p_driver_user_id: driverUserId,
      p_amount: amount,
      p_idempotency_key: idempotencyKey ?? null,
    });
    if (error) throw error;
    const result = data as Record<string, unknown>;
    logger.info('quota_recharged', { driverUserId, amount, newBalance: result.balance as number });
    return {
      balance: Number(result.balance ?? 0),
      recharged: Number(result.recharged ?? amount),
    };
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

  /**
   * Set a value in the platform_config table (admin only).
   */
  async setConfigValue(key: string, value: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('platform_config')
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) throw error;
    logger.info('config_updated', { key, value });
  },
};

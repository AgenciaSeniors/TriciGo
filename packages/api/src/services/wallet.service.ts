// ============================================================
// TriciGo — Wallet Service
// Client-side wallet operations. Financial mutations happen
// server-side via Edge Functions for safety.
// ============================================================

import type {
  WalletAccount,
  LedgerTransaction,
  WalletSummary,
  WalletAccountKind,
  DriverEarningsByZone,
  WalletRechargeRequest,
  WalletTransfer,
  DriverQuotaStatus,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { validate, rechargeSchema, sendGiftSchema, giftCodeSchema, cubanPhoneSchema } from '../schemas';
import { logger } from '@tricigo/utils';
import { NotFoundError } from '../errors';

export const walletService = {
  /**
   * Get a wallet account for the current user.
   *
   * `accountType` defaults to 'customer_cash' for backward compat
   * (the old signature was effectively `getAccount(userId)` = rider).
   * Drivers MUST pass 'driver_cash' — their earnings/quota live on a
   * separate account and the two never mix. A driver with rider
   * activity too will have BOTH rows in wallet_accounts; calling
   * without a type returns the rider one.
   */
  async getAccount(
    userId: string,
    accountType: WalletAccountKind = 'customer_cash',
  ): Promise<WalletAccount | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('account_type', accountType)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data as WalletAccount | null;
  },

  /**
   * Get wallet summary (balance, held, totals) for display.
   *
   * `accountType` selects which wallet to summarize:
   *   - 'customer_cash' (default) → rider balance
   *   - 'driver_cash' → driver earnings balance
   *
   * Returns the owning `account_id` so callers can paginate
   * `ledger_transactions` without a second lookup.
   */
  async getSummary(
    userId: string,
    accountType: WalletAccountKind = 'customer_cash',
  ): Promise<WalletSummary> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .rpc('get_wallet_summary', {
        p_user_id: userId,
        p_account_type: accountType,
      });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row ?? {
      available_balance: 0,
      held_balance: 0,
      total_earned: 0,
      total_spent: 0,
      currency: 'TRC',
      account_id: null,
    }) as WalletSummary;
  },

  /**
   * Top 5 zones by driver earnings for a date range. RLS-checked via
   * the `get_driver_earnings_by_zone` RPC (see migration 00128).
   */
  async getDriverEarningsByZone(params: {
    driverId: string;
    start: Date | string;
    end: Date | string;
  }): Promise<DriverEarningsByZone[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('get_driver_earnings_by_zone', {
      p_driver_id: params.driverId,
      p_start: typeof params.start === 'string' ? params.start : params.start.toISOString(),
      p_end: typeof params.end === 'string' ? params.end : params.end.toISOString(),
    });
    if (error) throw error;
    return (data as DriverEarningsByZone[] | null) ?? [];
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
  /**
   * Get available + held balance. Same backward-compat rule as
   * `getAccount`: defaults to 'customer_cash' (rider). Drivers MUST
   * pass 'driver_cash' to see their real earnings.
   *
   * Wallet v2 phase 2: also returns the USD-cents equivalent + the
   * exchange-rate snapshot taken at migration (00242). Callers that
   * want to render in USD use the `*UsdCents` fields; legacy callers
   * keep using `available` / `held` (CUP-pegged) without changes.
   */
  async getBalance(
    userId: string,
    accountType: WalletAccountKind = 'customer_cash',
  ): Promise<{
    available: number;
    held: number;
    availableUsdCents: number | null;
    heldUsdCents: number | null;
    migrationRate: number | null;
    migrationBonusPct: number | null;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_accounts')
      .select('balance, held_balance, balance_usd_cents, held_balance_usd_cents, migration_rate, migration_bonus_pct')
      .eq('user_id', userId)
      .eq('account_type', accountType)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!data) {
      return { available: 0, held: 0, availableUsdCents: null, heldUsdCents: null, migrationRate: null, migrationBonusPct: null };
    }
    const row = data as {
      balance: number;
      held_balance: number;
      balance_usd_cents: number | null;
      held_balance_usd_cents: number | null;
      migration_rate: string | number | null;
      migration_bonus_pct: string | number | null;
    };
    return {
      available: row.balance,
      held: row.held_balance,
      availableUsdCents: row.balance_usd_cents,
      heldUsdCents: row.held_balance_usd_cents,
      migrationRate: row.migration_rate != null ? Number(row.migration_rate) : null,
      migrationBonusPct: row.migration_bonus_pct != null ? Number(row.migration_bonus_pct) : null,
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

  // ==================== GIFTS ("Regalo") ====================
  // Closed-loop user-to-user gift of TriciCoin (00343-00345). Reframes
  // the P2P transfer removed in 00274: the recipient must be an active
  // TriciGo user and the gifted balance is spend-only (rides), never
  // withdrawable to fiat. Admin can reverse a gift + freeze wallets.

  /**
   * Send a gift to another user. Debits the sender's wallet and credits the
   * recipient's role wallet. `fromWallet` selects the source wallet by app
   * context (driver app → 'tricicoin', client/web → 'customer_cash'); when
   * omitted the server falls back to the sender's role wallet. The `send_gift`
   * RPC enforces caller identity, positive amount, active/non-frozen sender,
   * sufficient balance, and atomicity.
   * @returns the new wallet_transfers id
   */
  async sendGift(
    fromUserId: string,
    toUserId: string,
    amount: number,
    note?: string,
    fromWallet?: 'customer_cash' | 'tricicoin',
  ): Promise<string> {
    const valid = validate(sendGiftSchema, { fromUserId, toUserId, amount, note, fromWallet });
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('send_gift', {
      p_from_user_id: valid.fromUserId,
      p_to_user_id: valid.toUserId,
      p_amount: valid.amount,
      p_note: valid.note ?? null,
      // Only sent when the caller specifies the source wallet (app context).
      // Omitted otherwise so the server uses the role-based fallback.
      ...(valid.fromWallet ? { p_from_wallet: valid.fromWallet } : {}),
    });
    if (error) throw error;
    logger.info('gift_sent', { from: valid.fromUserId, to: valid.toUserId, amount: valid.amount });
    return data as string;
  },

  /**
   * Resolve a gift recipient by exact phone (+53XXXXXXXX). Server-side
   * rate-limited (30/h, anti-enumeration). Returns null when no active
   * user matches.
   */
  async findUserByPhone(
    phone: string,
  ): Promise<{ id: string; full_name: string; phone: string } | null> {
    const validPhone = validate(cubanPhoneSchema, phone);
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('find_user_by_phone', { p_phone: validPhone });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row as { id: string; full_name: string; phone: string } | undefined) ?? null;
  },

  /**
   * Resolve a gift recipient by their shareable code (referral_codes,
   * reused as the gift/QR code). Server-side rate-limited (30/h).
   */
  async findUserByGiftCode(
    code: string,
  ): Promise<{ id: string; full_name: string } | null> {
    const validCode = validate(giftCodeSchema, code);
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('find_user_by_gift_code', { p_code: validCode });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return (row as { id: string; full_name: string } | undefined) ?? null;
  },

  /**
   * Get gift/transfer history for a user (sent + received). RLS on
   * wallet_transfers restricts rows to sender or recipient.
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
      p_user_id: driverUserId,
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
   * Called after payment confirmation.
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

  /**
   * Wallet v2 PR 4: list the user's wallet recharge receipts so the
   * client can show a "Descargar comprobante" button next to each
   * historical recharge transaction. RLS on wallet_receipts (added
   * in migration 00235) already restricts SELECT to user_id=auth.uid().
   */
  async getReceipts(userId: string, limit = 50) {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_receipts')
      .select('id, payment_intent_id, receipt_no, pdf_storage_path, pdf_generated_at, usd_charged, tc_credited, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as Array<{
      id: string;
      payment_intent_id: string;
      receipt_no: string;
      pdf_storage_path: string | null;
      pdf_generated_at: string | null;
      usd_charged: string;
      tc_credited: string;
      created_at: string;
    }>;
  },

  /**
   * Wallet v2 PR 4: mint a short-lived signed URL for a private
   * receipts/<user_id>/<TG-...>.pdf path. Storage RLS already
   * enforces owner-only reads — this just hands the authenticated
   * user a fresh download token.
   */
  async getReceiptSignedUrl(storagePath: string, expirySec = 3600): Promise<string> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from('receipts')
      .createSignedUrl(storagePath, expirySec);
    if (error) throw error;
    if (!data?.signedUrl) throw new Error('signed_url_missing');
    return data.signedUrl;
  },
};

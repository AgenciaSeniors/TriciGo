// ============================================================
// TriciGo — Corporate Account Service
// Manages business accounts, employees, policy validation,
// and corporate ride billing.
// ============================================================

import type {
  CorporateAccount,
  CorporateEmployee,
  CorporateEmployeeWithUser,
  CorporateRide,
  CorporateBillingSummary,
  ServiceTypeSlug,
} from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const corporateService = {
  // ─────────────────────────── Registration & Lifecycle ───────────────────────────

  async registerAccount(params: {
    name: string;
    contact_phone: string;
    contact_email?: string;
    tax_id?: string;
    created_by: string;
  }): Promise<CorporateAccount> {
    const supabase = getSupabaseClient();

    // Create the corporate account
    const { data, error } = await supabase
      .from('corporate_accounts')
      .insert({
        name: params.name,
        contact_phone: params.contact_phone,
        contact_email: params.contact_email ?? null,
        tax_id: params.tax_id ?? null,
        created_by: params.created_by,
      })
      .select()
      .single();
    if (error) throw error;

    const account = data as CorporateAccount;

    // Add creator as corporate admin employee
    await supabase.from('corporate_employees').insert({
      corporate_account_id: account.id,
      user_id: params.created_by,
      role: 'admin',
      added_by: params.created_by,
    });

    // Create corporate wallet account
    await supabase.rpc('ensure_wallet_account', {
      p_user_id: account.id,
      p_type: 'corporate_cash',
    });

    return account;
  },

  async getAccount(accountId: string): Promise<CorporateAccount | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('corporate_accounts')
      .select('*')
      .eq('id', accountId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data as CorporateAccount | null;
  },

  async getMyAccounts(userId: string): Promise<CorporateAccount[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('corporate_employees')
      .select('corporate_account_id, corporate_accounts(*)')
      .eq('user_id', userId)
      .eq('is_active', true);
    if (error) throw error;
    return (data ?? [])
      .map((row: any) => row.corporate_accounts as CorporateAccount)
      .filter((a: CorporateAccount) => a.status === 'approved');
  },

  async updateAccount(
    accountId: string,
    updates: Partial<Pick<CorporateAccount,
      'name' | 'contact_phone' | 'contact_email' | 'tax_id' |
      'monthly_budget_trc' | 'per_ride_cap_trc' | 'allowed_service_types' |
      'allowed_hours_start' | 'allowed_hours_end'
    >>,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('corporate_accounts')
      .update(updates)
      .eq('id', accountId);
    if (error) throw error;
  },

  // ─────────────────────────── Admin Approval ───────────────────────────

  async approveAccount(accountId: string, adminId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('corporate_accounts')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', accountId);
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: 'approve_corporate',
      target_type: 'corporate_account',
      target_id: accountId,
    });
  },

  async rejectAccount(accountId: string, adminId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('corporate_accounts')
      .update({ status: 'rejected', suspended_reason: reason })
      .eq('id', accountId);
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: 'reject_corporate',
      target_type: 'corporate_account',
      target_id: accountId,
      reason,
    });
  },

  async suspendAccount(accountId: string, adminId: string, reason: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('corporate_accounts')
      .update({
        status: 'suspended',
        suspended_at: new Date().toISOString(),
        suspended_reason: reason,
      })
      .eq('id', accountId);
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: 'suspend_corporate',
      target_type: 'corporate_account',
      target_id: accountId,
      reason,
    });
  },

  async reactivateAccount(accountId: string, adminId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('corporate_accounts')
      .update({
        status: 'approved',
        suspended_at: null,
        suspended_reason: null,
      })
      .eq('id', accountId);
    if (error) throw error;

    await supabase.from('admin_actions').insert({
      admin_id: adminId,
      action: 'reactivate_corporate',
      target_type: 'corporate_account',
      target_id: accountId,
    });
  },

  // ─────────────────────────── Employee Management ───────────────────────────

  async addEmployee(
    accountId: string,
    userPhone: string,
    role: 'admin' | 'employee',
    addedBy: string,
  ): Promise<CorporateEmployee> {
    const supabase = getSupabaseClient();

    // Lookup user by phone
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('phone', userPhone)
      .single();
    if (userError || !user) throw new Error('USER_NOT_FOUND');

    const { data, error } = await supabase
      .from('corporate_employees')
      .insert({
        corporate_account_id: accountId,
        user_id: user.id,
        role,
        added_by: addedBy,
      })
      .select()
      .single();
    if (error) {
      if (error.code === '23505') throw new Error('EMPLOYEE_ALREADY_EXISTS');
      throw error;
    }
    return data as CorporateEmployee;
  },

  async removeEmployee(accountId: string, userId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('corporate_employees')
      .update({ is_active: false })
      .eq('corporate_account_id', accountId)
      .eq('user_id', userId);
    if (error) throw error;
  },

  async getEmployees(
    accountId: string,
    page = 0,
    pageSize = 20,
  ): Promise<CorporateEmployeeWithUser[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('corporate_employees')
      .select('*, users(full_name, phone)')
      .eq('corporate_account_id', accountId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    return (data ?? []) as CorporateEmployeeWithUser[];
  },

  async getEmployeeRole(
    accountId: string,
    userId: string,
  ): Promise<'admin' | 'employee' | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('corporate_employees')
      .select('role')
      .eq('corporate_account_id', accountId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();
    if (error) return null;
    return data?.role ?? null;
  },

  // ─────────────────────────── Policy Validation ───────────────────────────

  async validateCorporateRide(
    accountId: string,
    userId: string,
    fareTrc: number,
    serviceType: ServiceTypeSlug,
  ): Promise<{ valid: boolean; reason?: string }> {
    const supabase = getSupabaseClient();

    // 1. Check account is approved
    const { data: account } = await supabase
      .from('corporate_accounts')
      .select('*')
      .eq('id', accountId)
      .single();
    if (!account || account.status !== 'approved') {
      return { valid: false, reason: 'ACCOUNT_NOT_APPROVED' };
    }

    // 2. Check employee is active
    const role = await this.getEmployeeRole(accountId, userId);
    if (!role) {
      return { valid: false, reason: 'NOT_AN_EMPLOYEE' };
    }

    // 3. Per-ride fare cap
    if (account.per_ride_cap_trc > 0 && fareTrc > account.per_ride_cap_trc) {
      return { valid: false, reason: 'EXCEEDS_RIDE_CAP' };
    }

    // 4. Monthly budget
    if (account.monthly_budget_trc > 0) {
      const remaining = account.monthly_budget_trc - account.current_month_spent;
      if (fareTrc > remaining) {
        return { valid: false, reason: 'EXCEEDS_MONTHLY_BUDGET' };
      }
    }

    // 5. Service type allowed
    if (account.allowed_service_types.length > 0) {
      if (!account.allowed_service_types.includes(serviceType)) {
        return { valid: false, reason: 'SERVICE_TYPE_NOT_ALLOWED' };
      }
    }

    // 6. Allowed hours
    if (account.allowed_hours_start && account.allowed_hours_end) {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (currentTime < account.allowed_hours_start || currentTime > account.allowed_hours_end) {
        return { valid: false, reason: 'OUTSIDE_ALLOWED_HOURS' };
      }
    }

    return { valid: true };
  },

  // ─────────────────────────── Billing ───────────────────────────

  async recordCorporateRide(
    accountId: string,
    rideId: string,
    userId: string,
    fareTrc: number,
  ): Promise<void> {
    const supabase = getSupabaseClient();

    // Insert corporate ride record
    const { error: insertError } = await supabase
      .from('corporate_rides')
      .insert({
        corporate_account_id: accountId,
        ride_id: rideId,
        employee_user_id: userId,
        fare_trc: fareTrc,
      });
    if (insertError) throw insertError;

    // Increment current_month_spent via direct SQL update
    const account = await this.getAccount(accountId);
    if (account) {
      const { error: updateError } = await supabase
        .from('corporate_accounts')
        .update({ current_month_spent: account.current_month_spent + fareTrc })
        .eq('id', accountId);
      if (updateError) console.error('Failed to increment corporate spend:', updateError);
    }
  },

  async getCorporateRides(
    accountId: string,
    page = 0,
    pageSize = 20,
  ): Promise<CorporateRide[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('corporate_rides')
      .select('*')
      .eq('corporate_account_id', accountId)
      .order('created_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw error;
    return (data ?? []) as CorporateRide[];
  },

  async getBillingSummary(accountId: string): Promise<CorporateBillingSummary> {
    const supabase = getSupabaseClient();

    // Get current month rides
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { data: rides } = await supabase
      .from('corporate_rides')
      .select('fare_trc')
      .eq('corporate_account_id', accountId)
      .gte('created_at', monthStart);

    const totalRides = rides?.length ?? 0;
    const totalSpent = (rides ?? []).reduce((sum: number, r: any) => sum + r.fare_trc, 0);

    // Get budget
    const account = await this.getAccount(accountId);
    const budgetRemaining = account && account.monthly_budget_trc > 0
      ? Math.max(0, account.monthly_budget_trc - totalSpent)
      : -1; // -1 means unlimited

    return {
      total_rides: totalRides,
      total_spent_trc: totalSpent,
      budget_remaining_trc: budgetRemaining,
    };
  },

  // ─────────────────────────── Admin Listing ───────────────────────────

  async listAccounts(
    status?: string,
    page = 0,
    pageSize = 20,
  ): Promise<CorporateAccount[]> {
    const supabase = getSupabaseClient();
    let query = supabase
      .from('corporate_accounts')
      .select('*')
      .order('created_at', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as CorporateAccount[];
  },

  async getAccountEmployeeCount(accountId: string): Promise<number> {
    const supabase = getSupabaseClient();
    const { count, error } = await supabase
      .from('corporate_employees')
      .select('id', { count: 'exact', head: true })
      .eq('corporate_account_id', accountId)
      .eq('is_active', true);
    if (error) return 0;
    return count ?? 0;
  },

  async getCorporateBalance(accountId: string): Promise<number> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('wallet_accounts')
      .select('balance')
      .eq('user_id', accountId)
      .eq('account_type', 'corporate_cash')
      .single();
    if (error) return 0;
    return data?.balance ?? 0;
  },
};

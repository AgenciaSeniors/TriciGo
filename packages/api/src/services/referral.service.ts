// ============================================================
// TriciGo — Referral Service
// Manages referral codes, applications, history, and admin ops.
// ============================================================

import type { Referral, ReferralStatus } from '@tricigo/types';
import { getSupabaseClient } from '../client';

const DEFAULT_BONUS_CUP = 500; // 500 CUP whole pesos

export const referralService = {
  /**
   * Get or generate a referral code for the user.
   * Uses first 8 chars of user ID (uppercase) as a simple unique code.
   */
  async getOrCreateReferralCode(userId: string): Promise<string> {
    const supabase = getSupabaseClient();

    // Check if user already has referrals as referrer (reuse that code)
    const { data: existing } = await supabase
      .from('referrals')
      .select('code')
      .eq('referrer_id', userId)
      .limit(1);

    if (existing && existing.length > 0 && existing[0]) {
      return existing[0].code;
    }

    // Generate code from userId prefix
    return userId.substring(0, 8).toUpperCase();
  },

  /**
   * Apply a referral code. The current user becomes the referee.
   */
  async applyReferralCode(refereeId: string, code: string): Promise<Referral> {
    const supabase = getSupabaseClient();
    const normalizedCode = code.trim().toUpperCase();

    // Find the referrer by matching user ID prefix
    const { data: users, error: userErr } = await supabase
      .from('users')
      .select('id')
      .ilike('id', `${normalizedCode.toLowerCase()}%`);

    if (userErr) throw userErr;
    if (!users || users.length === 0 || !users[0]) {
      throw new Error('Código de referido inválido');
    }

    const referrerId = users[0].id;

    if (referrerId === refereeId) {
      throw new Error('No puedes usar tu propio código');
    }

    // Check if referee already used a referral
    const { data: existingRef } = await supabase
      .from('referrals')
      .select('id')
      .eq('referee_id', refereeId)
      .limit(1);

    if (existingRef && existingRef.length > 0) {
      throw new Error('Ya usaste un código de referido');
    }

    // Create the referral record
    const { data, error } = await supabase
      .from('referrals')
      .insert({
        referrer_id: referrerId,
        referee_id: refereeId,
        code: normalizedCode,
        status: 'pending',
        bonus_amount: DEFAULT_BONUS_CUP,
      })
      .select()
      .single();

    if (error) throw error;
    return data as Referral;
  },

  /**
   * Get referral history for a user (as referrer).
   */
  async getReferralHistory(userId: string): Promise<Referral[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('referrals')
      .select('*')
      .eq('referrer_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as Referral[];
  },

  /**
   * Check if user has already been referred by someone.
   */
  async hasBeenReferred(userId: string): Promise<boolean> {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('referrals')
      .select('id')
      .eq('referee_id', userId)
      .limit(1);
    return (data?.length ?? 0) > 0;
  },

  // ==================== ADMIN OPERATIONS ====================

  /**
   * Get all referrals with pagination and optional status filter.
   */
  async getAllReferrals(
    page = 0,
    pageSize = 20,
    statusFilter?: ReferralStatus,
  ): Promise<{ data: Referral[]; total: number }> {
    const supabase = getSupabaseClient();
    const from = page * pageSize;
    const to = from + pageSize - 1;

    let query = supabase
      .from('referrals')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (statusFilter) {
      query = query.eq('status', statusFilter);
    }

    const { data, error, count } = await query;
    if (error) throw error;
    return { data: data as Referral[], total: count ?? 0 };
  },

  /**
   * Get referral stats for admin dashboard.
   */
  async getReferralStats(): Promise<{
    total: number;
    pending: number;
    rewarded: number;
    invalidated: number;
    total_bonus_paid_cup: number;
  }> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('referrals')
      .select('status, bonus_amount');
    if (error) throw error;

    const referrals = data as { status: string; bonus_amount: number }[];
    const stats = {
      total: referrals.length,
      pending: 0,
      rewarded: 0,
      invalidated: 0,
      total_bonus_paid_cup: 0,
    };

    for (const r of referrals) {
      if (r.status === 'pending') stats.pending++;
      else if (r.status === 'rewarded') {
        stats.rewarded++;
        stats.total_bonus_paid_cup += r.bonus_amount;
      } else if (r.status === 'invalidated') stats.invalidated++;
    }

    return stats;
  },

  /**
   * Admin: manually reward a pending referral.
   * Uses the admin_reward_referral RPC function.
   */
  async rewardReferral(referralId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('admin_reward_referral', {
      p_referral_id: referralId,
    });
    if (error) throw error;
  },

  /**
   * Admin: invalidate a pending referral.
   * Uses the admin_invalidate_referral RPC function.
   */
  async invalidateReferral(referralId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('admin_invalidate_referral', {
      p_referral_id: referralId,
    });
    if (error) throw error;
  },
};

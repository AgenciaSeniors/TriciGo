// ============================================================
// TriciGo — Referral Service
// Manages referral codes, applications, and history.
// ============================================================

import type { Referral } from '@tricigo/types';
import { getSupabaseClient } from '../client';

const DEFAULT_BONUS_CENTAVOS = 50000; // 500 CUP

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
        bonus_amount: DEFAULT_BONUS_CENTAVOS,
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
};

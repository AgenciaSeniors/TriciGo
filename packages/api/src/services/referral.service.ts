// ============================================================
// TriciGo — Referral Service
// Manages referral codes, applications, history, and admin ops.
//
// R-CRIT-1 (2026-05-26): el flujo legacy resolvía code → referrer
// via `users.id ILIKE 'prefix%'`. Estaba doblemente roto:
//   - RLS `users_select_own` (00001:540) bloquea SELECT de otros
//     users → la query nunca matcheaba → "Código inválido" siempre.
//   - 8 hex chars = 2^32 espacio (colisión esperable a ~9300 users).
// Fix: tabla `referral_codes` + RPCs SECURITY DEFINER
// `get_or_create_referral_code` y `apply_referral_code`
// (migración 00319). Tolerancia: si la migración no se aplicó aún
// (PGRST202 / function does not exist), fallback al comportamiento
// legacy para no crashear la UI.
// ============================================================

import type { Referral, ReferralStatus } from '@tricigo/types';
import { getSupabaseClient } from '../client';

const DEFAULT_BONUS_CUP = 500; // 500 CUP whole pesos

function isMissingFunctionError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === 'PGRST202') return true;
  // Match ONLY the PostgREST "RPC not in schema cache" phrasing. Do NOT match a
  // generic Postgres "function <x> does not exist" (42883) — that can come from
  // an unresolved call INSIDE the RPC body (e.g. gen_random_bytes when the
  // search_path is wrong, see migration 00491). Such runtime errors must
  // propagate, not silently trigger the legacy fallback that returns an
  // unredeemable placeholder code.
  return !!error.message && /could not find the function/i.test(error.message);
}

export const referralService = {
  /**
   * Get or generate a referral code for the user.
   * Prefers the RPC `get_or_create_referral_code` (migration 00319).
   * Falls back to UUID-prefix legacy code if the migration isn't applied.
   */
  async getOrCreateReferralCode(userId: string): Promise<string> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc('get_or_create_referral_code');
    if (!error && typeof data === 'string' && data.length > 0) {
      return data;
    }

    if (error && !isMissingFunctionError(error)) {
      throw error;
    }

    // Migration 00319 not yet applied — legacy fallback.
    const { data: existing } = await supabase
      .from('referrals')
      .select('code')
      .eq('referrer_id', userId)
      .limit(1);

    if (existing && existing.length > 0 && existing[0]) {
      return existing[0].code;
    }

    return userId.substring(0, 8).toUpperCase();
  },

  /**
   * Apply a referral code. The current user becomes the referee.
   * Uses RPC `apply_referral_code` for atomic validation + insert.
   * Falls back to legacy ILIKE path only if the RPC doesn't exist.
   * Postgres error codes are mapped to user-facing Spanish strings.
   */
  async applyReferralCode(refereeId: string, code: string): Promise<Referral> {
    const supabase = getSupabaseClient();
    const normalizedCode = code.trim().toUpperCase();

    const { data: referralId, error } = await supabase.rpc('apply_referral_code', {
      p_code: normalizedCode,
    });

    if (!error && typeof referralId === 'string') {
      const { data, error: fetchErr } = await supabase
        .from('referrals')
        .select('*')
        .eq('id', referralId)
        .single();
      if (fetchErr) throw fetchErr;
      return data as Referral;
    }

    if (error) {
      // Custom error codes from the RPC
      if (error.code === 'P0001') throw new Error('Código de referido inválido');
      if (error.code === 'P0002') throw new Error('No puedes usar tu propio código');
      if (error.code === 'P0003') throw new Error('Ya usaste un código de referido');

      // Migration not yet applied — legacy fallback (works only for admins
      // due to RLS on users; non-admins get "invalid" same as before).
      if (isMissingFunctionError(error)) {
        return await applyReferralCodeLegacy(refereeId, normalizedCode);
      }

      throw error;
    }

    throw new Error('Código de referido inválido');
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

// ============================================================
// Legacy fallback — kept ONLY for the brief window where the
// migration isn't applied. Same broken behavior as before:
// non-admins hit RLS and get "invalid", admins resolve OK.
// ============================================================
async function applyReferralCodeLegacy(refereeId: string, normalizedCode: string): Promise<Referral> {
  const supabase = getSupabaseClient();

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

  const { data: existingRef } = await supabase
    .from('referrals')
    .select('id')
    .eq('referee_id', refereeId)
    .limit(1);

  if (existingRef && existingRef.length > 0) {
    throw new Error('Ya usaste un código de referido');
  }

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
}

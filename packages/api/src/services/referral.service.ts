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
//
// 00666: admins and marketing also read and save the four referral
// amounts (platform_config) from the Referidos page.
// ============================================================

import type { Referral, ReferralStatus } from '@tricigo/types';
import { getSupabaseClient } from '../client';
import { AppError } from '../errors';

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

/** What an invite code turned out to be (see applyInviteCode). */
export type InviteCodeResult =
  | { kind: 'source'; code: string; alreadySet: boolean }
  | { kind: 'referral'; referral: Referral };

/**
 * 00666: the four referral amounts in platform_config, in CUP. 0 on the two
 * driver keys means "use the rider amount"; 0 on referral_welcome_bonus_cup means off.
 */
export const REFERRAL_AMOUNT_KEYS = [
  'referral_bonus_cup',
  'referral_bonus_driver_cup',
  'referral_welcome_bonus_cup',
  'referral_welcome_bonus_driver_cup',
] as const;
export type ReferralAmountKey = (typeof REFERRAL_AMOUNT_KEYS)[number];
export type ReferralAmounts = Record<ReferralAmountKey, number>;

/**
 * What the payout triggers use when a key is missing or unreadable
 * (get_platform_config_numeric's fallback): 500 for referral_bonus_cup, 0 for
 * the rest.
 */
const REFERRAL_AMOUNT_DEFAULTS: ReferralAmounts = {
  referral_bonus_cup: 500,
  referral_bonus_driver_cup: 0,
  referral_welcome_bonus_cup: 0,
  referral_welcome_bonus_driver_cup: 0,
};

/** A decimal number as Postgres' numeric input accepts it (no hex, no empty string). */
const NUMERIC_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/** The `{error}` codes set_referral_amounts returns (00666), in Spanish. */
const REFERRAL_AMOUNT_ERRORS: Record<string, string> = {
  forbidden: 'No tienes permiso para cambiar los montos de referidos.',
  invalid_amount: 'Los montos tienen que ser números enteros, 0 o más.',
  unknown_key: 'Uno de los montos no existe. Recarga la página.',
  nothing_to_save: 'No hay cambios para guardar.',
};

function isReferralAmountKey(key: string): key is ReferralAmountKey {
  return (REFERRAL_AMOUNT_KEYS as readonly string[]).includes(key);
}

/** A finite JSON number, or a string that parses to one; anything else is null. */
function readAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMERIC_TEXT.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Builds the four amounts from key/value rows. A missing or unreadable value
 * takes the server's fallback, so the panel shows what a payout would use.
 */
function toAmounts(rows: { key: string; value: unknown }[]): ReferralAmounts {
  const out: ReferralAmounts = { ...REFERRAL_AMOUNT_DEFAULTS };
  for (const row of rows) {
    if (isReferralAmountKey(row.key)) {
      out[row.key] = readAmount(row.value) ?? REFERRAL_AMOUNT_DEFAULTS[row.key];
    }
  }
  return out;
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
      // 00658: referral rewards are once per confirmed phone.
      if (error.code === 'P0004') throw new Error('Confirma tu teléfono para usar un código de referido.');

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
   * Apply the optional "Código de invitación" typed at signup (00619). It is
   * either an acquisition code created in the admin (an influencer, a QR bag,
   * a driver group), which only records where the user came from, or a
   * friend's referral code, which keeps paying its bonus. Acquisition codes
   * are checked first; anything else goes through applyReferralCode and keeps
   * its error messages. While 00619 is not applied, every code is a referral.
   */
  async applyInviteCode(userId: string, code: string): Promise<InviteCodeResult> {
    const supabase = getSupabaseClient();
    const normalizedCode = code.trim().toUpperCase();

    const { data, error } = await supabase.rpc('apply_signup_code', { p_code: normalizedCode });
    if (error && !isMissingFunctionError(error)) throw error;
    if (!error && (data === 'applied' || data === 'already_set')) {
      return { kind: 'source', code: normalizedCode, alreadySet: data === 'already_set' };
    }

    const referral = await referralService.applyReferralCode(userId, normalizedCode);
    return { kind: 'referral', referral };
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

  /** 00666: the referral amounts (any signed-in user can read these non-secret keys). */
  async getReferralAmounts(): Promise<ReferralAmounts> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('platform_config')
      .select('key, value')
      .in('key', [...REFERRAL_AMOUNT_KEYS]);
    if (error) throw error;
    return toAmounts((data ?? []) as { key: string; value: unknown }[]);
  },

  /**
   * 00666: admins and marketing save the changed amounts (integers >= 0)
   * through set_referral_amounts. The function answers its refusals with an
   * `{error}` object, mapped here to a Spanish AppError (status 400, so the
   * panel shows the message instead of "session expired").
   */
  async setReferralAmounts(changes: Partial<ReferralAmounts>): Promise<ReferralAmounts> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('set_referral_amounts', { p_amounts: changes });
    if (error) {
      if (isMissingFunctionError(error)) {
        // Same text as the panel's other RPCs (adminRpcError in admin.service).
        throw new AppError(
          'La base de datos todavía no tiene esta función. Avisa al equipo técnico.',
          'REFERRAL_AMOUNTS_UNAVAILABLE',
          400,
        );
      }
      throw error;
    }
    const result = (data ?? {}) as { success?: unknown; error?: unknown; key?: unknown; amounts?: unknown };
    if (result.error || !result.success) {
      // Own keys only, so 'constructor' and the like get the generic text.
      // (Object.hasOwn is ES2022; the mobile apps compile this file with ES2021.)
      const code = typeof result.error === 'string' && Object.prototype.hasOwnProperty.call(REFERRAL_AMOUNT_ERRORS, result.error)
        ? result.error
        : null;
      const message = code ? REFERRAL_AMOUNT_ERRORS[code] : undefined;
      throw new AppError(
        message ?? 'No se pudieron guardar los montos.',
        code ? `REFERRAL_AMOUNTS_${code.toUpperCase()}` : 'REFERRAL_AMOUNTS_FAILED',
        400,
        typeof result.key === 'string' ? { key: result.key } : undefined,
      );
    }
    const { amounts } = result;
    if (!amounts || typeof amounts !== 'object' || Array.isArray(amounts)) {
      // Saved, but the reply has no amounts to show: read them again.
      return referralService.getReferralAmounts();
    }
    return toAmounts(Object.entries(amounts).map(([key, value]) => ({ key, value })));
  },

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

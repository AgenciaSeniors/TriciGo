// ============================================================
// TriciGo — Acquisition (signup attribution) codes, admin side (00619)
//
// Codes like MOTORENKO or BOLSAS-VEDADO, typed by a user in the optional
// "Código de invitación" at signup. They pay no bonus. They record where the
// user came from and, when a promotion is linked (00665), the server applies
// it to the user's next ride. Users apply them through
// referralService.applyInviteCode; this service is what the admin uses to
// create them and read their results.
// RLS on acquisition_codes and the admin_signup_code_stats RPC are for admin
// and marketing only (00642).
// ============================================================

import { getSupabaseClient } from '../client';

export type AcquisitionChannel = 'influencer' | 'ugc' | 'bolsas' | 'pantallas' | 'grupos' | 'medios' | 'otro';
export type AcquisitionAudience = 'pasajeros' | 'choferes' | 'ambos';

export interface AcquisitionCode {
  code: string;
  label: string;
  channel: AcquisitionChannel;
  audience: AcquisitionAudience;
  is_active: boolean;
  notes: string | null;
  /** 00665: the promotion people who register with this code get on their next ride. */
  promotion_id: string | null;
  created_at: string;
}

export interface AcquisitionCodeStats {
  code: string;
  label: string;
  channel: AcquisitionChannel;
  audience: AcquisitionAudience;
  is_active: boolean;
  created_at: string;
  signups: number;
  rider_signups: number;
  driver_signups: number;
  drivers_approved: number;
  riders_with_ride: number;
  drivers_with_ride: number;
  /** 00665: the linked promotion; null when none (or before the migration). */
  promotion_id: string | null;
  promotion_code: string | null;
  /** 00665: completed rides that used the linked promotion, by people who registered with the code. */
  promo_rides: number;
}

export interface NewAcquisitionCode {
  code: string;
  label: string;
  channel: AcquisitionChannel;
  audience: AcquisitionAudience;
  notes?: string | null;
  promotionId?: string | null;
}

/** Codes are stored upper-case: letters, digits and hyphens, 3 to 24 characters. */
export const ACQUISITION_CODE_PATTERN = /^[A-Z0-9-]{3,24}$/;

export function normalizeAcquisitionCode(code: string): string {
  return code.trim().toUpperCase();
}

const PROMOTION_GONE = 'La promoción ya no existe. Recarga la página y elige otra.';

export const acquisitionCodeService = {
  /** Every code with its signups, approvals and first rides, most signups first. */
  async getStats(): Promise<AcquisitionCodeStats[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_signup_code_stats');
    if (error) throw error;
    return ((data ?? []) as AcquisitionCodeStats[]).map((row) => ({
      ...row,
      signups: Number(row.signups),
      rider_signups: Number(row.rider_signups),
      driver_signups: Number(row.driver_signups),
      drivers_approved: Number(row.drivers_approved),
      riders_with_ride: Number(row.riders_with_ride),
      drivers_with_ride: Number(row.drivers_with_ride),
      promotion_id: row.promotion_id ?? null,
      promotion_code: row.promotion_code ?? null,
      promo_rides: Number(row.promo_rides ?? 0),
    }));
  },

  async create(input: NewAcquisitionCode): Promise<AcquisitionCode> {
    const code = normalizeAcquisitionCode(input.code);
    if (!ACQUISITION_CODE_PATTERN.test(code)) {
      throw new Error('El código solo puede tener letras, números y guiones (3 a 24 caracteres).');
    }
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('acquisition_codes')
      .insert({
        code,
        label: input.label.trim(),
        channel: input.channel,
        audience: input.audience,
        notes: input.notes?.trim() || null,
        // Only sent when chosen: before 00665 the column does not exist
        // and PostgREST rejects the unknown key (PGRST204).
        ...(input.promotionId ? { promotion_id: input.promotionId } : {}),
      })
      .select()
      .single();
    if (error) {
      if (error.code === '23505') throw new Error(`El código ${code} ya existe o es el código de referido de un usuario.`);
      if (error.code === '23503') throw new Error(PROMOTION_GONE);
      throw error;
    }
    return data as AcquisitionCode;
  },

  async setActive(code: string, isActive: boolean): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('acquisition_codes')
      .update({ is_active: isActive })
      .eq('code', code);
    if (error) throw error;
  },

  /**
   * Links a promotion to the code, or unlinks it with null (00665). An UPDATE
   * that RLS filters out answers OK with 0 rows, so it throws when no row
   * came back.
   */
  async setPromotion(code: string, promotionId: string | null): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('acquisition_codes')
      .update({ promotion_id: promotionId })
      .eq('code', code)
      .select('code');
    if (error) {
      if (error.code === '23503') throw new Error(PROMOTION_GONE);
      throw error;
    }
    if (!data || data.length === 0) {
      throw new Error('No se pudo cambiar la promoción del código. Recarga la página e intenta de nuevo.');
    }
  },
};

// ============================================================
// TriciGo — the operator's support shift (migration 00681)
// The panel's "En turno" switch. The server answers an expected refusal as `{ error: code }`
// (forbidden, whatsapp_required, invalid_whatsapp, invalid_request); it comes back here as an
// AppError whose `code` is that string.
// ============================================================

import { getSupabaseClient } from '../client';
import { isMissingRpc, throwIfRefused, unavailable } from './ride-assist.service';

/** What the switch shows (ops_support_shift_status). */
export interface SupportShiftStatus {
  /** The caller's row; null before she first uses the switch. */
  me: {
    on_shift: boolean;
    whatsapp_phone: string | null;
    shift_started_at: string | null;
    missed_in_a_row: number;
  } | null;
  /** The others on shift (active, with a number). */
  on_shift: { user_id: string; name: string }[];
  /** Her account phone, to prefill the number. */
  suggested_whatsapp: string | null;
}

/** What turning the switch did to her rides. */
export interface SupportShiftChange {
  /** Her open rides passed to someone else (off). */
  handed_over: number;
  /** Her open rides nobody could take (off). */
  kept: number;
  /** Rides waiting for someone that she picked up (on). */
  picked_up: number;
}

export const supportShiftService = {
  async getStatus(): Promise<SupportShiftStatus> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('ops_support_shift_status');
    if (error) {
      if (isMissingRpc(error)) throw unavailable('ops_support_shift_status');
      throw error;
    }
    throwIfRefused('ops_support_shift_status', data);
    return data as SupportShiftStatus;
  },

  /** Turns the shift on or off. `whatsapp` must be E.164 (see normalizeSupportWhatsapp). */
  async setShift(on: boolean, whatsapp?: string): Promise<SupportShiftChange> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('ops_set_support_shift', {
      p_on: on,
      p_whatsapp: whatsapp ?? null,
    });
    if (error) {
      if (isMissingRpc(error)) throw unavailable('ops_set_support_shift');
      throw error;
    }
    throwIfRefused('ops_set_support_shift', data);
    const r = data as Partial<SupportShiftChange>;
    return {
      handed_over: typeof r.handed_over === 'number' ? r.handed_over : 0,
      kept: typeof r.kept === 'number' ? r.kept : 0,
      picked_up: typeof r.picked_up === 'number' ? r.picked_up : 0,
    };
  },
};

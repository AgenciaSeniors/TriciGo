// ============================================================
// TriciGo — launch pulse and driver outreach, admin side (00621)
//
// admin_launch_pulse(p_weeks): the weekly numbers that say what limits the
// service (requests that never got a driver, drivers online per hour,
// signups, approvals, referrals, consents), in Havana weeks.
// admin_incomplete_driver_signups(): drivers stuck in pending_verification,
// with what they still have to upload and the last time the team wrote.
// driver_outreach_log: one row per contact; who and when come from the
// session (trigger), the admin only picks the channel and a note.
// All three are admin-only (is_admin() in the RPCs, RLS on the table).
// ============================================================

import { getSupabaseClient } from '../client';

export interface LaunchPulseWeek {
  /** Monday of the week, Havana time (YYYY-MM-DD). */
  week_start: string;
  is_current: boolean;
  requests: number;
  riders_requesting: number;
  completed: number;
  riders_completed: number;
  accepted_canceled: number;
  offered_not_accepted: number;
  no_offer: number;
  open: number;
  /** Hours with an online-drivers snapshot in this week (0 before 00621). */
  hours_measured: number;
  online_avg: number | null;
  online_avg_day: number | null;
  online_avg_night: number | null;
  hours_nobody_pct: number | null;
  drivers_seen_online: number;
  signups: number;
  rider_signups: number;
  driver_signups: number;
  drivers_approved: number;
  coded_signups: number;
  signups_with_push: number;
  marketing_opt_ins: number;
  referrals_created: number;
  referrals_rewarded: number;
}

export interface LaunchPulseNow {
  users: number;
  users_with_push: number;
  users_opted_in: number;
  drivers_approved: number;
  drivers_approved_with_push: number;
  drivers_pending: number;
  drivers_under_review: number;
  drivers_online_now: number;
}

export interface LaunchPulse {
  generated_at: string;
  timezone: string;
  /** First hour with an online-drivers snapshot, or null if there is none yet. */
  online_since: string | null;
  now: LaunchPulseNow;
  /** Newest first. */
  weeks: LaunchPulseWeek[];
}

export type OutreachChannel = 'whatsapp' | 'llamada' | 'sms' | 'otro';

export interface IncompleteDriverSignup {
  driver_profile_id: string;
  user_id: string;
  full_name: string | null;
  phone: string | null;
  signed_up_at: string;
  last_sign_in_at: string | null;
  /** Required documents uploaded and not rejected (0 to 5). */
  docs_uploaded: number;
  /** Required documents never uploaded, in onboarding order. */
  missing_docs: string[];
  /** Required documents whose latest upload was rejected. */
  rejected_docs: string[];
  has_push: boolean;
  contact_count: number;
  last_contact_at: string | null;
  last_contact_by: string | null;
  last_contact_channel: OutreachChannel | null;
  last_contact_note: string | null;
}

export const launchPulseService = {
  /** The last `weeks` Havana weeks (1 to 52), newest first, plus current totals. */
  async getPulse(weeks = 12): Promise<LaunchPulse> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_launch_pulse', { p_weeks: weeks });
    if (error) throw error;
    return data as LaunchPulse;
  },
};

export const driverOutreachService = {
  /** Drivers stuck in pending_verification, newest signup first. */
  async getIncompleteSignups(): Promise<IncompleteDriverSignup[]> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc('admin_incomplete_driver_signups');
    if (error) throw error;
    return ((data ?? []) as IncompleteDriverSignup[]).map((row) => ({
      ...row,
      docs_uploaded: Number(row.docs_uploaded),
      contact_count: Number(row.contact_count),
      missing_docs: row.missing_docs ?? [],
      rejected_docs: row.rejected_docs ?? [],
    }));
  },

  /**
   * Records that the team contacted a driver. Throws when nothing was written:
   * an INSERT that RLS rejects is an error, but checking the returned row also
   * covers any path where PostgREST answers OK without storing it.
   */
  async logContact(driverProfileId: string, channel: OutreachChannel, note?: string | null): Promise<void> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('driver_outreach_log')
      .insert({ driver_profile_id: driverProfileId, channel, note: note?.trim() || null })
      .select('id');
    if (error) throw error;
    if (!data || data.length === 0) throw new Error('No se pudo registrar el contacto.');
  },
};

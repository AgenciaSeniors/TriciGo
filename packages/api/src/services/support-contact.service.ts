// ============================================================
// TriciGo — the public support contact (migration 00679)
// The number riders and drivers write to: someone on shift, else the last one who was. Public
// (anon can call it), so the help screens work before sign-in.
// ============================================================

import type { SupportContactResult } from '@tricigo/utils';
import { getSupabaseClient } from '../client';

export const supportContactService = {
  /**
   * get_support_contact. Any failure (function missing, server error, refusal, no network) is
   * `unreachable`, so the caller falls back to its cached number.
   */
  async fetch(): Promise<SupportContactResult> {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('get_support_contact');
      if (error) return { status: 'unreachable' };
      const r = data as { phone?: unknown; error?: unknown } | null;
      if (!r || r.error) return { status: 'unreachable' };
      return { status: 'ok', phone: typeof r.phone === 'string' && r.phone ? r.phone : null };
    } catch {
      return { status: 'unreachable' };
    }
  },
};

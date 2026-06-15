// ============================================================
// TriciGo — Block Service (Apple Guideline 1.2 UGC moderation)
// ============================================================
//
// Peer-to-peer mutual block ("no rematch"). The mutual effect lives in
// dispatch_ride (migration 00437); these are thin wrappers over the RPCs.

import type { BlockedUser } from '@tricigo/types';
import { getSupabaseClient } from '../client';

export const blockService = {
  /** Block another user. Idempotent server-side. Throws so the UI can confirm. */
  async blockUser(blockedUserId: string, reason?: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('block_user', {
      p_blocked_id: blockedUserId,
      p_reason: reason ?? null,
    });
    if (error) throw error;
  },

  /** Remove a block the caller created. */
  async unblockUser(blockedUserId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase.rpc('unblock_user', {
      p_blocked_id: blockedUserId,
    });
    if (error) throw error;
  },

  /**
   * The caller's block list (with name + avatar resolved).
   * Tolerant: if the RPC isn't deployed yet (migration not applied), returns []
   * so the "Blocked users" screen renders empty instead of crashing.
   */
  async getBlockedUsers(): Promise<BlockedUser[]> {
    const supabase = getSupabaseClient();
    try {
      const { data, error } = await supabase.rpc('get_blocked_users');
      if (error) return [];
      return (data ?? []) as BlockedUser[];
    } catch {
      return [];
    }
  },
};

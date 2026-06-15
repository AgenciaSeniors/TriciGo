// ============================================================
// TriciGo — User Block Types (Apple Guideline 1.2 UGC moderation)
// ============================================================

/** A user the caller has blocked (no-rematch). Shape of get_blocked_users(). */
export interface BlockedUser {
  blocked_id: string;
  full_name: string | null;
  avatar_url: string | null;
  reason: string | null;
  created_at: string;
}

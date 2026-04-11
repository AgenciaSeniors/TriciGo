// ============================================================
// TriciGo — Share Ride Utilities
// Single source of truth for share URLs and token management
// ============================================================

/** Canonical base URL for public shared ride tracking */
export const SHARE_BASE_URL = 'https://tricigo.com/track/share';

/**
 * Build a full share URL from a token.
 * All consumers MUST use this instead of hardcoding domains.
 */
export function buildShareUrl(token: string): string {
  return `${SHARE_BASE_URL}/${token}`;
}

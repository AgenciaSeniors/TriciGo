// ============================================================
// Panel roles for Edge Functions (00642, marketing role).
//
// Admins and super_admins may call the panel's broadcast functions for anything. Marketing may
// send bulk campaign e-mail, and pushes only in the categories its pages use (campaign,
// announcement, promo, blog). Any other category (ride, system, safety, payment…) is refused,
// and so is an uncategorized push, such as the system notices sendToUser sends.
//
// The server checks the category, not the number of recipients. The panel's Notificaciones
// page pushes to one user with category 'announcement', which this gate allows. Keeping that
// page admin-only is the panel's job (menu + middleware), not the server's.
//
// Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
// Pure module: no remote imports, so packages/api's vitest runs it unmodified.
// Keep the panel roles in sync with packages/utils/src/adminPanelAccess.ts (PANEL_ROLES), which
// Deno cannot import.
// ============================================================

/** The push categories marketing's pages send. */
export const MARKETING_PUSH_CATEGORIES: ReadonlySet<string> = new Set(['campaign', 'announcement', 'promo', 'blog']);

export function isAdminRole(role: unknown): boolean {
  return role === 'admin' || role === 'super_admin';
}

/** Roles that may call the panel's broadcast functions at all. */
export function isPanelStaffRole(role: unknown): boolean {
  return isAdminRole(role) || role === 'marketing';
}

/**
 * Admins send any category. Marketing sends only its content categories, never an uncategorized
 * push. Recipients are not checked: a one-user push in a content category is allowed.
 */
export function canSendPush(role: unknown, category: string | null | undefined): boolean {
  if (isAdminRole(role)) return true;
  return role === 'marketing' && typeof category === 'string' && MARKETING_PUSH_CATEGORIES.has(category);
}

/**
 * The `data` keys the panel's content pushes send (packages/api notification.service.ts:
 * broadcastToActiveUsers and sendCampaignPush). The apps react to other keys on receipt and
 * navigate on them when tapped (event, ride_id…), so a marketing push may carry only these.
 */
export const MARKETING_PUSH_DATA_KEYS: readonly string[] = ['deep_link', 'content_type', 'content_id'];

/** The allowed keys of `data` that hold strings. Anything else, inherited keys included, is dropped. */
export function marketingPushData(data: unknown): Record<string, string> {
  const kept: Record<string, string> = {};
  if (typeof data !== 'object' || data === null) return kept;
  for (const key of MARKETING_PUSH_DATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === 'string') kept[key] = value;
  }
  return kept;
}

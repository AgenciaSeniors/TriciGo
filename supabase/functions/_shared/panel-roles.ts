// ============================================================
// Panel roles for Edge Functions (00642, marketing role; 00672 and 00673, operator role).
//
// Admins and super_admins may call the panel's broadcast functions for anything. Marketing may
// send bulk campaign e-mail, and pushes only in the categories its pages use (campaign,
// announcement, promo, blog). Any other category (ride, system, safety, payment…) is refused,
// and so is an uncategorized push, such as the system notices sendToUser sends.
//
// For marketing the server checks the category, not the number of recipients: the panel keeps the
// Notificaciones page from it (menu + middleware). The operator opens that page (00673) and may
// send only its one-user 'announcement', which the server checks: one category, one recipient.
//
// Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
// Pure module: no remote imports, so packages/api's vitest runs it unmodified.
// The panel roles here are not a copy of PANEL_ROLES in packages/utils/src/adminPanelAccess.ts
// (Deno cannot import it). isPanelStaffRole opens bulk e-mail and campaigns, including their
// pushes, which the operator does not get (spec docs/superpowers/specs/2026-10-25-operator-role-design.md
// section 6). The operator never joins isPanelStaffRole; isOpsRole (00672) is its separate gate.
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
 * Operations staff (00672): the admins and the operator. Driver onboarding (documents, contracts,
 * deleting an account that never finished signing up) accepts them; money and broadcasts do not.
 */
export function isOpsRole(role: unknown): boolean {
  return isAdminRole(role) || role === 'operator';
}

/** The four roles of the panel's team: an account with one of them is never a driver applicant. */
export function isPanelRole(role: unknown): boolean {
  return isAdminRole(role) || role === 'marketing' || role === 'operator';
}

/**
 * Admins send any category. Marketing sends only its content categories, never an uncategorized
 * push, to any number of people. The operator (00673) sends only an 'announcement', to exactly one
 * person: the Notificaciones page's one-user push. `recipientIds` is the request's user list.
 */
export function canSendPush(role: unknown, category: string | null | undefined,
                            recipientIds?: readonly string[]): boolean {
  if (isAdminRole(role)) return true;
  if (role === 'operator') {
    return category === 'announcement' && recipientIds?.length === 1;
  }
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

/**
 * The `data` a push may carry, by the caller's role: everything for admins and internal calls
 * (null role), marketing's content keys only, and nothing for the operator (00673), whose push is
 * a plain message to one person.
 */
export function pushDataForRole<T>(role: unknown, data: T): T | Record<string, string> {
  if (role === null || role === undefined || isAdminRole(role)) return data;
  if (role === 'operator') return {};
  return marketingPushData(data);
}

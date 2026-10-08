// ============================================================
// Panel roles for Edge Functions (00641, marketing role).
//
// Admins and super_admins may call the panel's broadcast functions for anything. Marketing may
// send the pushes its pages send (campaigns, home announcements, promotions, blog) and bulk
// campaign e-mail, nothing else: no ride, system, safety or one-user pushes.
//
// Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
// Pure module: no remote imports, so packages/api's vitest runs it unmodified.
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

/** Admins send any category. Marketing sends only its content categories, never an uncategorized push. */
export function canSendPush(role: unknown, category: string | null | undefined): boolean {
  if (isAdminRole(role)) return true;
  return role === 'marketing' && typeof category === 'string' && MARKETING_PUSH_CATEGORIES.has(category);
}

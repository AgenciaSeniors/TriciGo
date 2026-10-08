/**
 * Who may open which admin panel page (00642, marketing role).
 *
 * One module for the middleware, the sidebar and the bottom bar, so a menu never offers a page
 * the middleware refuses. It only shapes the panel: every permission is also enforced on the
 * server (RLS, RPC gates, Edge Functions).
 *
 * Imported as `@tricigo/utils/adminPanelAccess` so the middleware does not load the utils barrel.
 * Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
 */
// Keep in sync with supabase/functions/_shared/panel-roles.ts (isPanelStaffRole): Edge Functions
// run in Deno and cannot import @tricigo/utils.
const PANEL_ROLES = ['admin', 'super_admin', 'marketing'] as const;

export type PanelRole = (typeof PANEL_ROLES)[number];

/** The pages marketing may open. Each one also covers its sub-pages. */
export const MARKETING_ROUTES: readonly string[] = [
  '/launch-pulse',
  '/funnel',
  '/code-performance',
  '/segments',
  '/reports',
  '/referrals',
  '/promotions',
  '/campaigns',
  '/announcements',
  '/blog',
];

/** Where marketing lands, and where the middleware sends it from any other page. */
export const MARKETING_HOME = '/launch-pulse';

export function isPanelRole(role: unknown): role is PanelRole {
  return typeof role === 'string' && (PANEL_ROLES as readonly string[]).includes(role);
}

/** The role the menus use. When the role could not be read: the least privileged one. */
export function menuRole(role: PanelRole | null | undefined): PanelRole {
  return role ?? 'marketing';
}

export function panelHome(role: PanelRole): string {
  return role === 'marketing' ? MARKETING_HOME : '/';
}

/** Admins open everything, marketing its allow-list. Any other value opens nothing. */
export function canOpenPanelPath(role: PanelRole, pathname: string): boolean {
  if (role === 'admin' || role === 'super_admin') return true;
  if (role !== 'marketing') return false;
  return MARKETING_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

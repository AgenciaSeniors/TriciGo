/**
 * Who may open which admin panel page (00641, marketing role).
 *
 * One module for the middleware, the sidebar and the bottom bar, so a menu never offers a page
 * the middleware refuses. It only shapes the panel: every permission is also enforced on the
 * server (RLS, RPC gates, Edge Functions).
 *
 * Imported as `@tricigo/utils/adminPanelAccess` so the middleware does not load the utils barrel.
 * Spec: docs/superpowers/specs/2026-10-08-marketing-role-design.md
 */
export type PanelRole = 'admin' | 'super_admin' | 'marketing';

const PANEL_ROLES: readonly string[] = ['admin', 'super_admin', 'marketing'];

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
  return typeof role === 'string' && PANEL_ROLES.includes(role);
}

/** The role the menus use. When the role could not be read: the least privileged one. */
export function menuRole(role: PanelRole | null | undefined): PanelRole {
  return role ?? 'marketing';
}

export function panelHome(role: PanelRole): string {
  return role === 'marketing' ? MARKETING_HOME : '/';
}

export function canOpenPanelPath(role: PanelRole, pathname: string): boolean {
  if (role !== 'marketing') return true;
  return MARKETING_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

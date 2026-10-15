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

/** The pages marketing may open. Each one also covers its sub-pages, except MARKETING_DENIED. */
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
  // Read-only (00663). Marketing acts only on /support.
  '/rides',
  '/drivers',
  '/users',
  '/reviews',
  '/support',
  '/disputes',
  '/incidents',
  '/lost-found',
  '/incomplete-drivers',
  '/pois',
  '/validation',
];

/** Sub-pages of an allowed page that marketing still may not open: the stuck-ride assist tools. */
const MARKETING_DENIED: readonly RegExp[] = [/^\/rides\/[^/]+\/assist(?:\/|$)/];

/** The pages only super admins may open (00661, team invitations). Each one also covers its sub-pages. */
export const SUPER_ADMIN_ROUTES: readonly string[] = ['/equipo'];

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

function underRoute(routes: readonly string[], pathname: string): boolean {
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/**
 * Super admins open everything, admins everything but the super-admin pages, marketing its
 * allow-list. Any other value opens nothing.
 */
export function canOpenPanelPath(role: PanelRole, pathname: string): boolean {
  if (underRoute(SUPER_ADMIN_ROUTES, pathname)) return role === 'super_admin';
  if (role === 'admin' || role === 'super_admin') return true;
  if (role !== 'marketing') return false;
  return underRoute(MARKETING_ROUTES, pathname) && !MARKETING_DENIED.some((re) => re.test(pathname));
}

/**
 * Whether the panel shows actions (approve, edit, cancel, move money). Admins and super admins
 * act; marketing only reads, except on /support. An unknown role acts on nothing. It only shapes
 * the UI: the server refuses those actions on its own.
 */
export function panelCanAct(role: PanelRole | null | undefined): boolean {
  return role === 'admin' || role === 'super_admin';
}

/**
 * The cookie the middleware writes with the account's panel role, on every page it lets through.
 * The browser reads it to draw the menus without asking the database again. It only shapes the UI:
 * the middleware decides which pages open and the server enforces every permission, so editing
 * this cookie gives nobody anything.
 */
export const PANEL_ROLE_COOKIE = 'tricigo_panel_role';

/** The panel role in a Cookie header or document.cookie; null when absent or not a panel role. */
export function panelRoleFromCookies(cookies: string | null | undefined): PanelRole | null {
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== PANEL_ROLE_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
    return isPanelRole(value) ? value : null;
  }
  return null;
}

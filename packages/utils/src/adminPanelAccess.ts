/**
 * Who may open which admin panel page, and which actions each role sees (00642 marketing,
 * 00668 operator).
 *
 * One module for the middleware, the sidebar, the bottom bar and the pages, so a menu never offers
 * a page the middleware refuses and a page never offers an action the role cannot take. It only
 * shapes the panel: every permission is also enforced on the server (RLS, RPC gates, Edge Functions).
 *
 * Imported as `@tricigo/utils/adminPanelAccess` so the middleware does not load the utils barrel.
 * Specs: docs/superpowers/specs/2026-10-08-marketing-role-design.md,
 *        docs/superpowers/specs/2026-10-25-operator-role-design.md
 */
// Edge Functions keep their own role checks in supabase/functions/_shared/panel-roles.ts (Deno
// cannot import @tricigo/utils). That file is not a copy of this list: its isPanelStaffRole opens
// bulk e-mail and campaigns, which the operator does not get.
const PANEL_ROLES = ['admin', 'super_admin', 'marketing', 'operator'] as const;

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

/**
 * The pages the operator may open (00668). '/' is the dashboard only; every other route also covers
 * its sub-pages, except OPERATOR_DENIED. What it may do on each page is in panelCan.
 */
export const OPERATOR_ROUTES: readonly string[] = [
  '/',
  '/reports',
  '/launch-pulse',
  '/live-map',
  '/rides',
  '/support',
  '/incidents',
  '/disputes',
  '/lost-found',
  '/drivers',
  '/incomplete-drivers',
  '/businesses',
  '/users',
  '/reviews',
  '/fraud',
  '/cancellations',
  '/wallet',
  '/promotions',
  '/referrals',
];

/** Sub-pages of an allowed page that the operator still may not open: gifts move money. */
const OPERATOR_DENIED: readonly RegExp[] = [/^\/wallet\/gifts(?:\/|$)/];

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
  return routes.some((route) => pathname === route || (route !== '/' && pathname.startsWith(`${route}/`)));
}

/**
 * A conservative, fail-closed reading of the raw pathname: each segment is decoded on its own,
 * and a segment that decodes to "." or ".." or contains a slash or a backslash makes the whole
 * path unreadable (null). So an encoded letter cannot slip past the lists below, and an encoded
 * separator cannot change which page the lists think it is.
 */
function normalizePanelPath(pathname: string): string | null {
  const segments: string[] = [];
  for (const raw of pathname.replace(/\\/g, '/').split('/')) {
    if (raw === '') continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')) return null;
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/**
 * Super admins open everything, admins everything but the super-admin pages, marketing and the
 * operator their allow-lists. Any other value opens nothing.
 */
export function canOpenPanelPath(role: PanelRole, rawPathname: string): boolean {
  const pathname = normalizePanelPath(rawPathname);
  if (pathname === null) return false;
  if (underRoute(SUPER_ADMIN_ROUTES, pathname)) return role === 'super_admin';
  if (role === 'admin' || role === 'super_admin') return true;
  if (role === 'marketing') {
    return underRoute(MARKETING_ROUTES, pathname) && !MARKETING_DENIED.some((re) => re.test(pathname));
  }
  if (role === 'operator') {
    return underRoute(OPERATOR_ROUTES, pathname) && !OPERATOR_DENIED.some((re) => re.test(pathname));
  }
  return false;
}

/**
 * What a page may offer beyond opening it. Each capability is one kind of action, or the full
 * detail of a ride, driver or user. The server refuses each action on its own for anyone without it.
 */
export type PanelCapability =
  /** Full ride, driver and user detail (GPS, documents, chat, wallets). Without it: the read-only views. */
  | 'detail.full'
  /** Cancel a ride; assist a searching or stuck ride. */
  | 'rides.act'
  /** Reply to support tickets and change their status. */
  | 'tickets.act'
  /** Incidents, disputes and lost items: notes, status, resolution. Refunds are money.act. */
  | 'cases.act'
  /** Driver onboarding: documents, approve, reject, suspend, upload, contract, outreach. */
  | 'drivers.review'
  /** Fleet requests and the drivers a fleet invites. */
  | 'fleets.review'
  /** Corporate client accounts: approve, reject, suspend, reactivate, commission. */
  | 'corporate.clients'
  /** Block and unblock accounts. */
  | 'users.block'
  /** Delete an account that never finished signing up. */
  | 'accounts.delete_pending'
  /** Reviews, fraud alerts and the collusion queue (/cancellations). */
  | 'moderation.act'
  /** Places (POIs) and their submissions. */
  | 'pois.act'
  /** Anything that moves money: wallet adjustments, gifts, top-ups, refunds, bonus pushes. */
  | 'money.act'
  /** Create, edit, pause and delete promotions. */
  | 'promotions.write'
  /** See what waits for approval: the strip and the menu dot. */
  | 'promotions.approve'
  /** Edit the referral amounts; without it the card is read-only. */
  | 'referrals.amounts'
  /** Reward or invalidate a referral: it moves money. */
  | 'referrals.rewards'
  /** The audit log and the cards that read it. */
  | 'audit.read';

const MARKETING_CAPABILITIES: readonly PanelCapability[] = ['tickets.act', 'promotions.write', 'referrals.amounts'];

/**
 * Delivery 1 of the operator role (00668): it reads everything it opens and acts on nothing yet.
 * Each later delivery adds the capabilities its server functions open.
 */
const OPERATOR_CAPABILITIES: readonly PanelCapability[] = ['detail.full'];

/** Whether the panel offers this capability to the role. It only shapes the UI. */
export function panelCan(role: PanelRole | null | undefined, cap: PanelCapability): boolean {
  if (role === 'admin' || role === 'super_admin') return true;
  if (role === 'marketing') return MARKETING_CAPABILITIES.includes(cap);
  if (role === 'operator') return OPERATOR_CAPABILITIES.includes(cap);
  return false;
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

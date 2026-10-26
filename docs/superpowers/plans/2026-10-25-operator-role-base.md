# Operator Role, Delivery 1 (Base) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `operator` panel role that can be invited from `/equipo`, opens its pages, reads everything they show (rides with GPS, drivers with documents, users, wallets read-only, metrics, promotions, referrals), receives the support and SOS pushes and the daily digest, and acts on nothing yet.

**Architecture:**
- **Server.** A new `user_role` value (00667). In 00668:
  - helpers `is_operator()` and `is_ops_staff()`;
  - one `<table>_select_operator` SELECT policy per table the pages read;
  - in-place, md5-guarded patches of the read RPC gates and of the role lists;
  - an SOS push trigger, and a self-check block that aborts on anything unexpected.
- **Panel.** `adminPanelAccess` gains the operator's routes and replaces the all-or-nothing `panelCanAct` with per-action capabilities (`panelCan` / `usePanelCan`). In this delivery the operator has only `detail.full`, so every action button is hidden for it.
- **Edge Functions.** Only two e-mail templates change.

**Tech Stack:** Supabase Postgres 16 (plpgsql, RLS), Next.js 15 admin panel (React 19, TypeScript), vitest, Deno Edge Function templates, bash rehearsal on a local Postgres 16.

**Spec:** `docs/superpowers/specs/2026-10-25-operator-role-design.md`. This plan covers its delivery 1. The design tables in the spec are the requirements; the "Notes from planning" section at the end lists where this plan refines the spec.

---

## Before you start

- **Read** CLAUDE.md, at least these sections:
  - "Rol `marketing` en el panel admin (00641/00642, PR #1115)" and "Lo que marketing lee desde 00663": the same method, for another role.
  - "Equipo del panel: invitaciones (00661)".
  - "Cómo probar migraciones SQL de verdad sin tocar prod" and "En Windows, sin sandbox": local Postgres.
  - "Aplicar migraciones pesadas por MCP" and "Trampa de herramienta" (00659): backslashes over MCP.
  - "Pre-flight para elegir número de migración".
- **Worktree:** `C:\Users\Eduardo\TriciGo\.claude\worktrees\operador-role-architecture-d90e21`, branch `claude/operador-role-architecture-d90e21`. Run `pnpm install --frozen-lockfile` once (≈10 min). Afterwards `git checkout HEAD -- pnpm-lock.yaml` if it changed.
- **Migration numbers:** on 2026-10-25 master ended at 00666; 00662 (#1160) and 00569 (#965) are taken by open PRs. Re-check both commands right before Task 9 and before applying:
  ```bash
  git fetch origin master && git ls-tree origin/master supabase/migrations/ | awk -F'\t' '{print $2}' | sort -r | head -5
  for pr in $(gh pr list --state open --json number --jq '.[].number'); do gh pr view $pr --json files --jq '.files[].path' | grep supabase/migrations; done
  ```
  If 00667 or 00668 is taken, renumber everything in this plan (file names, the `00668:` prefix of every error message, the rehearsal folder).
- **Drafts:** the migration and the rehearsal files are ready next to this plan, in `docs/superpowers/plans/2026-10-25-operator-role-base/`. Tasks 9 to 11 move them into place with `git mv`; nothing is left behind in that folder. They were written against prod as measured on 2026-10-25. Every md5 in them comes from prod, and every new function's md5 was computed from the exact text in the file.

## File map

**Server**

| File | Change |
|---|---|
| `supabase/migrations/00667_operator_role_enum.sql` | Create. `ALTER TYPE user_role ADD VALUE 'operator'` |
| `supabase/migrations/00668_operator_role_base.sql` | Create (from the draft). Helpers, policies, views, gates, role lists, SOS push, checks |
| `supabase/tests/00668/{capture-prod.sql,stubs.sql,seed.sql,run.sh}` | Create (from the drafts) |
| `supabase/tests/00668/prod-objects.sql` | Create: generated from prod by `capture-prod.sql` |
| `supabase/functions/_shared/email-templates/team_invitation.ts` (+ `.test.ts`) | Operator label |
| `supabase/functions/_shared/email-templates/team_daily_digest.ts` (+ `.test.ts`) | `seesPending` |

**Shared packages**

| File | Change |
|---|---|
| `packages/utils/src/adminPanelAccess.ts` (+ `__tests__/adminPanelAccess.test.ts`) | Operator routes, capabilities |
| `packages/types/src/enums.ts` | `UserRole` gains `'operator'` |
| `packages/api/src/services/team.service.ts` | `TeamRole` gains `'operator'` |
| `packages/api/src/services/admin.service.ts` (+ `__tests__/admin.test.ts`) | Delivery details fallback to `ops_delivery_details` |
| `packages/i18n/src/locales/{es,en,pt}/admin.json` | `role_operator` in three blocks |

**Admin panel**

| File | Change |
|---|---|
| `apps/admin/src/lib/usePanelCan.ts` | Create; replaces `useCanAct.ts` (deleted) |
| Pages that used `useCanAct` | disputes, incidents, `incidents/[id]`, lost-found, incomplete-drivers, reviews, pois, `pois/submissions`, `rides/[id]`, `drivers/[id]`, `users/[id]` |
| Pages with no gating today | wallet, `businesses/[id]` (+ `components/FleetReview.tsx`), fraud, cancellations, `cancellations/[id]`, support, `rides/[id]/assist` (+ `components/support/Assist*.tsx`), promotions, referrals (+ `components/referrals/ReferralAmountsCard.tsx`), home `app/page.tsx` |
| `apps/admin/src/components/layout/{Header,Sidebar}.tsx` | Role label, menus |
| `apps/admin/src/app/equipo/page.tsx`, `apps/admin/src/app/users/page.tsx` | Role in lists |

**Docs:** `CLAUDE.md`, a new section.

---

### Task 1: Operator routes and capabilities in `adminPanelAccess`

**Files:**
- Modify: `packages/utils/src/adminPanelAccess.ts` (whole file)
- Test: `packages/utils/src/__tests__/adminPanelAccess.test.ts` (whole file)

- [ ] **Step 1: Write the failing tests.** Replace the whole test file with:

```ts
import { describe, expect, it } from 'vitest';
import {
  MARKETING_HOME,
  MARKETING_ROUTES,
  OPERATOR_ROUTES,
  PANEL_ROLE_COOKIE,
  SUPER_ADMIN_ROUTES,
  canOpenPanelPath,
  isPanelRole,
  menuRole,
  panelCan,
  panelHome,
  panelRoleFromCookies,
  type PanelCapability,
  type PanelRole,
} from '../adminPanelAccess';

const ALL_CAPABILITIES: PanelCapability[] = [
  'detail.full', 'rides.act', 'tickets.act', 'cases.act', 'drivers.review', 'fleets.review',
  'corporate.clients', 'users.block', 'accounts.delete_pending', 'moderation.act', 'pois.act',
  'money.act', 'promotions.write', 'promotions.approve', 'referrals.amounts', 'referrals.rewards',
  'audit.read',
];

describe('isPanelRole', () => {
  it('accepts the four panel roles', () => {
    for (const role of ['admin', 'super_admin', 'marketing', 'operator']) expect(isPanelRole(role)).toBe(true);
  });

  it('rejects every other value', () => {
    for (const role of ['customer', 'driver', '', 'Admin', 'Operator', null, undefined, 42]) expect(isPanelRole(role)).toBe(false);
  });
});

describe('canOpenPanelPath', () => {
  it('lets admins and super admins open everything', () => {
    for (const path of ['/', '/wallet', '/settings/pricing', '/promotions']) {
      expect(canOpenPanelPath('admin', path)).toBe(true);
      expect(canOpenPanelPath('super_admin', path)).toBe(true);
    }
  });

  it('lets marketing open its pages and their sub-pages', () => {
    for (const route of MARKETING_ROUTES) {
      expect(canOpenPanelPath('marketing', route)).toBe(true);
      expect(canOpenPanelPath('marketing', `${route}/abc`)).toBe(true);
    }
  });

  it('keeps marketing out of everything else', () => {
    for (const path of ['/', '/wallet', '/wallet/gifts', '/settings', '/notifications', '/content',
      '/competitors', '/earnings', '/cancellations', '/cancellations/1', '/live-map', '/fraud',
      '/businesses', '/partners', '/quests', '/audit']) {
      expect(canOpenPanelPath('marketing', path)).toBe(false);
    }
  });

  it('opens the read-only pages to marketing (00663)', () => {
    for (const path of ['/rides', '/rides/abc', '/drivers', '/drivers/abc', '/users', '/users/abc',
      '/reviews', '/support', '/disputes', '/incidents', '/incidents/abc', '/lost-found',
      '/incomplete-drivers', '/pois', '/pois/submissions', '/validation']) {
      expect(canOpenPanelPath('marketing', path)).toBe(true);
    }
  });

  it('keeps marketing out of the stuck-ride assist page under an open page', () => {
    for (const path of ['/rides/abc/assist', '/rides/abc/assist/', '/rides/abc/assist/x']) {
      expect(canOpenPanelPath('marketing', path)).toBe(false);
      expect(canOpenPanelPath('admin', path)).toBe(true);
    }
    expect(canOpenPanelPath('marketing', '/rides/abc/assistance')).toBe(true);
  });

  it('lets the operator open its pages and their sub-pages, assist included (00668)', () => {
    for (const route of OPERATOR_ROUTES) {
      expect(canOpenPanelPath('operator', route)).toBe(true);
      if (route !== '/') expect(canOpenPanelPath('operator', `${route}/abc`)).toBe(true);
    }
    for (const path of ['/rides/abc/assist', '/wallet/receipts', '/cancellations/1', '/businesses/abc']) {
      expect(canOpenPanelPath('operator', path)).toBe(true);
    }
  });

  it('keeps the operator out of gifts, settings, team, audit, earnings and marketing pages', () => {
    for (const path of ['/wallet/gifts', '/wallet/gifts/x', '/settings', '/settings/pricing', '/equipo',
      '/audit', '/earnings', '/notifications', '/pois', '/campaigns', '/announcements', '/blog',
      '/content', '/segments', '/funnel', '/code-performance', '/validation', '/partners', '/quests',
      '/competitors', '/preview']) {
      expect(canOpenPanelPath('operator', path)).toBe(false);
    }
  });

  it('does not take a longer name for a sub-page', () => {
    expect(canOpenPanelPath('marketing', '/promotionsx')).toBe(false);
    expect(canOpenPanelPath('marketing', '/blog-admin')).toBe(false);
    expect(canOpenPanelPath('operator', '/ridesx')).toBe(false);
    expect(canOpenPanelPath('operator', '/wallet/giftsx')).toBe(true);
  });

  it('opens the Equipo page and its sub-pages only for super admins', () => {
    for (const path of ['/equipo', '/equipo/x']) {
      expect(canOpenPanelPath('super_admin', path)).toBe(true);
      expect(canOpenPanelPath('admin', path)).toBe(false);
      expect(canOpenPanelPath('marketing', path)).toBe(false);
      expect(canOpenPanelPath('operator', path)).toBe(false);
    }
    expect(SUPER_ADMIN_ROUTES).toContain('/equipo');
  });

  it('does not take a longer name for the Equipo page', () => {
    expect(canOpenPanelPath('admin', '/equipos')).toBe(true);
  });

  it('lets no other role open anything, even if the middleware check is skipped', () => {
    for (const role of ['customer', 'driver', '', 'Admin']) {
      for (const path of ['/', '/wallet', '/promotions']) {
        expect(canOpenPanelPath(role as PanelRole, path)).toBe(false);
      }
    }
  });
});

describe('panelHome and menuRole', () => {
  it('sends marketing to the launch pulse, admins and operators to the dashboard', () => {
    expect(panelHome('marketing')).toBe(MARKETING_HOME);
    expect(canOpenPanelPath('marketing', MARKETING_HOME)).toBe(true);
    expect(panelHome('admin')).toBe('/');
    expect(panelHome('super_admin')).toBe('/');
    expect(panelHome('operator')).toBe('/');
    expect(canOpenPanelPath('operator', '/')).toBe(true);
  });

  it('uses the least privileged menus when the role is unknown', () => {
    expect(menuRole(null)).toBe('marketing');
    expect(menuRole(undefined)).toBe('marketing');
    expect(menuRole('admin')).toBe('admin');
    expect(menuRole('operator')).toBe('operator');
  });
});

describe('panelRoleFromCookies', () => {
  it('reads the role the middleware wrote', () => {
    expect(panelRoleFromCookies(`a=1; ${PANEL_ROLE_COOKIE}=marketing; b=2`)).toBe('marketing');
    expect(panelRoleFromCookies(`${PANEL_ROLE_COOKIE}=super_admin`)).toBe('super_admin');
    expect(panelRoleFromCookies(`${PANEL_ROLE_COOKIE}=operator`)).toBe('operator');
  });

  it('ignores a value that is not a panel role', () => {
    expect(panelRoleFromCookies(`${PANEL_ROLE_COOKIE}=customer`)).toBeNull();
    expect(panelRoleFromCookies(`${PANEL_ROLE_COOKIE}=`)).toBeNull();
    expect(panelRoleFromCookies(`${PANEL_ROLE_COOKIE}=admin%00`)).toBeNull();
  });

  it('does not take another cookie whose name ends the same way', () => {
    expect(panelRoleFromCookies(`x${PANEL_ROLE_COOKIE}=admin`)).toBeNull();
  });

  it('is null without the cookie or without cookies at all', () => {
    expect(panelRoleFromCookies('a=1; b=2')).toBeNull();
    expect(panelRoleFromCookies('')).toBeNull();
    expect(panelRoleFromCookies(undefined)).toBeNull();
  });

  it('does not throw on a value that is not valid URI encoding', () => {
    expect(panelRoleFromCookies(`${PANEL_ROLE_COOKIE}=%E0%A4%A`)).toBeNull();
  });
});

describe('panelCan', () => {
  it('gives admins and super admins every capability', () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(panelCan('admin', cap)).toBe(true);
      expect(panelCan('super_admin', cap)).toBe(true);
    }
  });

  it('gives marketing tickets, promotions and the referral amounts, and nothing else', () => {
    const granted = ALL_CAPABILITIES.filter((cap) => panelCan('marketing', cap));
    expect(granted).toEqual(['tickets.act', 'promotions.write', 'referrals.amounts']);
  });

  it('gives the operator the full detail pages and no action yet (delivery 1)', () => {
    const granted = ALL_CAPABILITIES.filter((cap) => panelCan('operator', cap));
    expect(granted).toEqual(['detail.full']);
  });

  it('never gives the operator money, promotions, referral rewards or the audit log', () => {
    for (const cap of ['money.act', 'promotions.write', 'promotions.approve', 'referrals.amounts',
      'referrals.rewards', 'audit.read', 'corporate.clients', 'pois.act'] as PanelCapability[]) {
      expect(panelCan('operator', cap)).toBe(false);
    }
  });

  it('gives nothing to an unknown role', () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(panelCan(null, cap)).toBe(false);
      expect(panelCan(undefined, cap)).toBe(false);
      expect(panelCan('customer' as PanelRole, cap)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/adminPanelAccess.test.ts`
Expected: FAIL. `OPERATOR_ROUTES` and `panelCan` are not exported, and `isPanelRole('operator')` is false.

- [ ] **Step 3: Implement.** Replace the whole `packages/utils/src/adminPanelAccess.ts` with:

```ts
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
 * The pages the operator may open (00668). Each one also covers its sub-pages, except
 * OPERATOR_DENIED. What it may do on each page is in panelCan.
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
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/**
 * Super admins open everything, admins everything but the super-admin pages, marketing and the
 * operator their allow-lists. Any other value opens nothing.
 */
export function canOpenPanelPath(role: PanelRole, pathname: string): boolean {
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
  /** Reviews, fraud alerts and the collusion queue. */
  | 'moderation.act'
  /** Places (POIs) and their submissions. */
  | 'pois.act'
  /** Anything that moves money: wallet adjustments, gifts, top-ups, refunds, bonus pushes. */
  | 'money.act'
  /** Create, edit, pause and delete promotions. */
  | 'promotions.write'
  /** The promotions waiting for an admin: the strip and the menu dot. */
  | 'promotions.approve'
  /** The referral amounts card. */
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/adminPanelAccess.test.ts`
Expected: PASS, every test.

- [ ] **Step 5: Commit**

```bash
git add packages/utils/src/adminPanelAccess.ts packages/utils/src/__tests__/adminPanelAccess.test.ts
git commit -m "feat(utils): operator panel routes and per-action capabilities"
```

---

### Task 2: `usePanelCan` replaces `useCanAct`

**Files:**
- Create: `apps/admin/src/lib/usePanelCan.ts`
- Delete: `apps/admin/src/lib/useCanAct.ts`
- Modify: `apps/admin/src/app/disputes/page.tsx`, `apps/admin/src/app/incidents/page.tsx`, `apps/admin/src/app/incidents/[id]/page.tsx`, `apps/admin/src/app/lost-found/page.tsx`, `apps/admin/src/app/incomplete-drivers/page.tsx`, `apps/admin/src/app/reviews/page.tsx`, `apps/admin/src/app/pois/page.tsx`, `apps/admin/src/app/pois/submissions/page.tsx`, `apps/admin/src/app/rides/[id]/page.tsx`, `apps/admin/src/app/drivers/[id]/page.tsx`, `apps/admin/src/app/users/[id]/page.tsx`

The admin app has no test runner. The capabilities themselves are tested in Task 1; here the check is the type checker and, in Task 13, the build.

**Key change.** Four pages (disputes, incidents, `incidents/[id]`, lost-found) used `canAct` both to pick the data source (full table vs panel view) and to show actions. The operator needs the full table but no actions, so each of them gets two booleans:
- `fullData = can('detail.full')` picks the source;
- `canAct = can('cases.act')` shows the actions.

- [ ] **Step 1: Create the hook** `apps/admin/src/lib/usePanelCan.ts`:

```ts
'use client';

import { useCallback } from 'react';
import { panelCan, type PanelCapability } from '@tricigo/utils/adminPanelAccess';
import { usePanelRole } from './panelRole';

/**
 * What the signed-in role may do on the page (00668), and whether the role is known yet.
 * Pages that read different data by role wait for `ready`. It only shapes the UI: the server
 * refuses every action on its own.
 */
export function usePanelCan(): { can: (cap: PanelCapability) => boolean; ready: boolean } {
  const { role, loading } = usePanelRole();
  const can = useCallback((cap: PanelCapability) => panelCan(role, cap), [role]);
  return { can, ready: !loading };
}
```

- [ ] **Step 2: Delete the old hook**

```bash
git rm apps/admin/src/lib/useCanAct.ts
```

- [ ] **Step 3: Disputes** (`apps/admin/src/app/disputes/page.tsx`)
  - Import: replace `import { useCanAct } from '@/lib/useCanAct';` with `import { usePanelCan } from '@/lib/usePanelCan';`.
  - Line 46: replace `  const { canAct, ready } = useCanAct();` with:
    ```tsx
      const { can, ready } = usePanelCan();
      // The operator reads the full disputes (evidence, notes) but resolves none yet (00668).
      const fullData = can('detail.full');
      const canAct = can('cases.act');
    ```
  - Line 118: replace `      const data = canAct` with `      const data = fullData`.
  - Line 128: replace `  }, [statusFilter, t, canAct, ready]);` with `  }, [statusFilter, t, fullData, ready]);`.
  - Leave every other `canAct` as it is (resolve form, notes section, page copy).

- [ ] **Step 4: Incidents list** (`apps/admin/src/app/incidents/page.tsx`)
  - Import: replace `import { useCanAct } from '@/lib/useCanAct';` with `import { usePanelCan } from '@/lib/usePanelCan';`.
  - Line 52: replace `  const { canAct, ready } = useCanAct();` with:
    ```tsx
      const { can, ready } = usePanelCan();
      // The operator reads the full incidents but acts on none yet (00668).
      const fullData = can('detail.full');
      const canAct = can('cases.act');
    ```
  - Line 86: `      const data = canAct` → `      const data = fullData`.
  - Line 98: `  }, [page, statusFilter, beginRequest, canAct, ready]);` → `  }, [page, statusFilter, beginRequest, fullData, ready]);`.

- [ ] **Step 5: Incident detail** (`apps/admin/src/app/incidents/[id]/page.tsx`)
  - Import: replace `import { useCanAct } from '@/lib/useCanAct';` with `import { usePanelCan } from '@/lib/usePanelCan';`.
  - Line 73: replace `  const { canAct, ready } = useCanAct();` with:
    ```tsx
      const { can, ready } = usePanelCan();
      // The operator reads the full incident but acts on none yet (00668).
      const fullData = can('detail.full');
      const canAct = can('cases.act');
    ```
  - Line 88: `      const data = canAct` → `      const data = fullData`.
  - Line 110: `  }, [id, canAct, ready]);` → `  }, [id, fullData, ready]);`.

- [ ] **Step 6: Lost items** (`apps/admin/src/app/lost-found/page.tsx`)
  - Import: replace `import { useCanAct } from '@/lib/useCanAct';` with `import { usePanelCan } from '@/lib/usePanelCan';`.
  - Line 64: replace `  const { canAct, ready } = useCanAct();` with:
    ```tsx
      const { can, ready } = usePanelCan();
      // The operator reads the full lost items but acts on none yet (00668).
      const fullData = can('detail.full');
      const canAct = can('cases.act');
    ```
  - Line 91: `      const data = canAct` → `      const data = fullData`.
  - Line 101: `  }, [statusFilter, t, canAct, ready]);` → `  }, [statusFilter, t, fullData, ready]);`.

- [ ] **Step 7: Pages that only hide actions.** In each file, replace `import { useCanAct } from '@/lib/useCanAct';` with `import { usePanelCan } from '@/lib/usePanelCan';`, then replace its `useCanAct()` line:

| File | Old line | New lines |
|---|---|---|
| `incomplete-drivers/page.tsx:256` | `  const { canAct } = useCanAct();` | `  const { can } = usePanelCan();`<br>`  const canAct = can('drivers.review');` |
| `reviews/page.tsx:52` | `  const { canAct } = useCanAct();` | `  const { can } = usePanelCan();`<br>`  const canAct = can('moderation.act');` |
| `pois/page.tsx:34` | `  const { canAct } = useCanAct();` | `  const { can } = usePanelCan();`<br>`  const canAct = can('pois.act');` |
| `pois/submissions/page.tsx:46` | `  const { canAct } = useCanAct();` | `  const { can } = usePanelCan();`<br>`  const canAct = can('pois.act');` |

- [ ] **Step 8: The three detail pages pick their component by `detail.full`.** In `rides/[id]/page.tsx` (line 601), `drivers/[id]/page.tsx` (line 1336) and `users/[id]/page.tsx` (line 555):
  - replace `import { useCanAct } from '@/lib/useCanAct';` with `import { usePanelCan } from '@/lib/usePanelCan';`;
  - replace
    ```tsx
      const { canAct, ready } = useCanAct();
      if (!ready) return null;
      return canAct ? <AdminRideDetailPage /> : <RideDetailReadOnly rideId={id} />;
    ```
    with
    ```tsx
      const { can, ready } = usePanelCan();
      if (!ready) return null;
      return can('detail.full') ? <AdminRideDetailPage /> : <RideDetailReadOnly rideId={id} />;
    ```
    using each page's own component names (`AdminDriverDetailPage`/`DriverDetailReadOnly driverId={id}`, `AdminUserDetailPage`/`UserDetailReadOnly userId={id}`).

  The action buttons inside the full components are gated in Task 4.

- [ ] **Step 9: Nothing else imports the old hook**

Run: `git grep -n "useCanAct\|panelCanAct" -- apps packages`
Expected: no output.

- [ ] **Step 10: Type-check**

Run: `pnpm --filter @tricigo/admin exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add apps/admin/src/lib/usePanelCan.ts apps/admin/src/app
git commit -m "refactor(admin): per-action capabilities instead of one canAct flag"
```

---

### Task 3: The role in types, team, labels and menus

**Files:**
- Modify: `packages/types/src/enums.ts:6`, `packages/api/src/services/team.service.ts:22`
- Modify: `apps/admin/src/app/equipo/page.tsx:20`, `apps/admin/src/app/users/page.tsx:20-26,54-58`
- Modify: `apps/admin/src/components/layout/Header.tsx`, `apps/admin/src/components/layout/Sidebar.tsx`
- Modify: `packages/i18n/src/locales/{es,en,pt}/admin.json`

- [ ] **Step 1: Types**
  - `packages/types/src/enums.ts:6` becomes `export type UserRole = 'customer' | 'driver' | 'admin' | 'super_admin' | 'marketing' | 'operator';`
  - `packages/api/src/services/team.service.ts:22` becomes `export type TeamRole = 'super_admin' | 'admin' | 'marketing' | 'operator';`

- [ ] **Step 2: Equipo.** `apps/admin/src/app/equipo/page.tsx:20` becomes `const ROLES: TeamRole[] = ['super_admin', 'admin', 'operator', 'marketing'];`.

- [ ] **Step 3: Users list** (`apps/admin/src/app/users/page.tsx`)
  - Add to `ROLE_CLASS` after the `marketing` line:
    ```tsx
      operator: 'bg-teal-500/10 text-teal-700 dark:text-teal-400',
    ```
  - In `roleLabel`, the fallbacks object becomes:
    ```tsx
        customer: 'Pasajero', driver: 'Conductor', admin: 'Admin', super_admin: 'Super admin', marketing: 'Marketing',
        operator: 'Operador',
    ```
  - Contrast: text `-700` on a `-500/10` tint, and `-400` in dark mode, follows CLAUDE.md's rule for badges.

- [ ] **Step 4: Locales.** In each of `packages/i18n/src/locales/es/admin.json`, `en/admin.json` and `pt/admin.json`, add `role_operator` next to `role_marketing` in its three blocks. Keep the commas valid: in `header`, `role_marketing` is the last key, so give it a comma.

| Block | es | en | pt |
|---|---|---|---|
| `header` (line ~48) | `"role_operator": "Operador"` | `"role_operator": "Operator"` | `"role_operator": "Operador"` |
| `users` (line ~626) | `"role_operator": "Operador",` | `"role_operator": "Operator",` | `"role_operator": "Operador",` |
| `team` (line ~2736) | `"role_operator": "Operador",` | `"role_operator": "Operator",` | `"role_operator": "Operador",` |

Run: `pnpm check:i18n`
Expected: no parity error.

- [ ] **Step 5: Header** (`apps/admin/src/components/layout/Header.tsx`)
  - Import line 7 becomes `import { canOpenPanelPath, menuRole } from '@tricigo/utils/adminPanelAccess';`.
  - Line 74 `  const isMarketing = menuRole(role) === 'marketing';` becomes:
    ```tsx
      const panelRole = menuRole(role);
      const isMarketing = panelRole === 'marketing';
    ```
  - The role label (lines 206-208) becomes:
    ```tsx
                        {panelRole === 'marketing'
                          ? t('header.role_marketing', { defaultValue: 'Marketing' })
                          : panelRole === 'operator'
                            ? t('header.role_operator', { defaultValue: 'Operador' })
                            : t('header.role_admin', { defaultValue: 'Administrador' })}
    ```
  - Line 212 `              {!isMarketing && (` (the "Mi perfil" item, which opens `/settings`) becomes `              {canOpenPanelPath(panelRole, '/settings') && (`.
  - `{!isMarketing && <NotificationBell />}` stays: the operator gets the SOS bell.

- [ ] **Step 6: Sidebar** (`apps/admin/src/components/layout/Sidebar.tsx`)
  - Import line 8 becomes `import { canOpenPanelPath, menuRole, panelCan, panelHome } from '@tricigo/utils/adminPanelAccess';`.
  - Line 187 `    if (panelRole === 'marketing') return;` becomes `    if (!panelCan(panelRole, 'promotions.approve')) return;`.
  - The comment above it ("for the people who approve them") still holds.
  - `AdminShell.tsx` and `BottomNav.tsx` do not change. The operator is not marketing, so it gets the waiting-rides banner and the default bottom bar, whose four tabs it can all open.

- [ ] **Step 7: Type-check**

Run: `pnpm --filter @tricigo/admin exec tsc --noEmit && pnpm --filter @tricigo/api exec tsc --noEmit && pnpm --filter @tricigo/types exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/types packages/api/src/services/team.service.ts packages/i18n apps/admin/src
git commit -m "feat(admin): operator role in the team, labels and menus"
```

---

### Task 4: The full detail pages hide the actions the role lacks

**Files:**
- Modify: `apps/admin/src/app/rides/[id]/page.tsx`, `apps/admin/src/app/drivers/[id]/page.tsx`, `apps/admin/src/app/users/[id]/page.tsx`

In each file, add `import { usePanelCan } from '@/lib/usePanelCan';` if Task 2 did not already, and, as the second line of the full component (right after `const { t } = useTranslation('admin');`), add `  const { can } = usePanelCan();`. The components are `AdminRideDetailPage` (line 77), `AdminDriverDetailPage` (line 96) and `AdminUserDetailPage` (line 47).

- [ ] **Step 1: Ride detail: cancel.** At line 198, `          {CANCELABLE_STATUSES.includes(ride.status) && (` becomes `          {can('rides.act') && CANCELABLE_STATUSES.includes(ride.status) && (`. The "Asistir" link above it stays: the operator opens the assist page in read-only mode (Task 5).

- [ ] **Step 2: Driver detail: actions menu.** Add right after `const { can } = usePanelCan();`:
  ```tsx
    const canReview = can('drivers.review');
    const canMoney = can('money.act');
    const canDeletePending = can('accounts.delete_pending');
  ```
  Then in the actions menu (lines 498-563):
  - Wrap the whole `{/* Actions menu */}` block, `<div className="relative" ref={actionsMenuRef}> … </div>`, in `{(canReview || canMoney || canDeletePending) && ( … )}`.
  - Prefix the three status buttons with `canReview &&`: `{(status === 'under_review' || …) && (` becomes `{canReview && (status === 'under_review' || …) && (`. Do the same for the reject block (`{canReview && (status === 'under_review' || status === 'pending_verification') && (`) and the suspend block (`{canReview && status === 'approved' && (`).
  - Wrap the wallet part (`{/* Wallet ops — always available */}`, its divider and its button) in `{canMoney && ( <> … </> )}`, and update the comment to `{/* Wallet ops — money.act only */}`.
  - Wrap the delete part (its comment, divider and button) in `{canDeletePending && ( <> … </> )}`.

- [ ] **Step 3: Driver detail: documents and contract**
  - Line 645, the "upload placeholder" button `onClick={() => handleAdminUploadDoc(docType)}`: wrap it in `{canReview && ( … )}`.
  - Line 714, `{!docVerified && rejectingDocId !== doc.id && (` (verify/reject controls) becomes `{canReview && !docVerified && rejectingDocId !== doc.id && (`.
  - Line 795, `{!docVerified && rejectingDocId !== doc.id && (` (admin replace) becomes `{canReview && !docVerified && rejectingDocId !== doc.id && (`.
  - Line 856, the "generate contract" `<button onClick={handleGenerateContract} …>`: wrap it in `{canReview && ( … )}`.
  - The download buttons (lines 833, 842) stay. The operator reads contracts through the new storage policy.

- [ ] **Step 4: User detail: actions** (`users/[id]/page.tsx`, the button row at lines 213-244)
  - Wrap the "Ajustar saldo TC" button (line 214) in `{can('money.act') && ( … )}`.
  - Wrap the block/unblock ternary (`{user.is_active ? ( … ) : ( … )}`) in `{can('users.block') && ( … )}`.
  - The delete button condition `{user.role !== 'admin' && user.role !== 'super_admin' && (` becomes `{can('accounts.delete_pending') && !isPanelRole(user.role) && (`, with `import { isPanelRole } from '@tricigo/utils/adminPanelAccess';`. No team member can be deleted from here, marketing and operators included; the Edge Function will refuse them too in delivery 2.
  - The level selector already disables itself for anyone but super admins (`isSuperAdmin`), which covers the operator.

- [ ] **Step 5: Type-check and lint**

Run: `pnpm --filter @tricigo/admin exec tsc --noEmit && pnpm --filter @tricigo/admin exec eslint "src/app/rides/[[]id]/page.tsx" "src/app/drivers/[[]id]/page.tsx" "src/app/users/[[]id]/page.tsx" --config ../../tools/lint-rules.config.mjs`
Expected: no errors. Bracketed folders need the `[[]id]` escape in the glob.

- [ ] **Step 6: Commit**

```bash
git add "apps/admin/src/app/rides/[id]/page.tsx" "apps/admin/src/app/drivers/[id]/page.tsx" "apps/admin/src/app/users/[id]/page.tsx"
git commit -m "feat(admin): detail pages hide the actions a role cannot take"
```

---

### Task 5: The other operator pages hide their actions

**Files:**
- Modify: `apps/admin/src/app/wallet/page.tsx`, `apps/admin/src/app/businesses/[id]/page.tsx`, `apps/admin/src/components/FleetReview.tsx`, `apps/admin/src/app/fraud/page.tsx`, `apps/admin/src/app/cancellations/page.tsx`, `apps/admin/src/app/cancellations/[id]/page.tsx`, `apps/admin/src/app/support/page.tsx`, `apps/admin/src/app/rides/[id]/assist/page.tsx`, `apps/admin/src/components/support/AssistActiveRide.tsx`, `apps/admin/src/components/support/AssistCandidates.tsx`, `apps/admin/src/app/promotions/page.tsx`, `apps/admin/src/app/referrals/page.tsx`, `apps/admin/src/components/referrals/ReferralAmountsCard.tsx`, `apps/admin/src/app/page.tsx`

In every page below, add `import { usePanelCan } from '@/lib/usePanelCan';` and `  const { can } = usePanelCan();` right after the page's `const { t } = useTranslation('admin');`. The exceptions are promotions and referrals (Steps 8 and 9 replace their role lines with it) and the home page (Step 10 says where). Components get a prop instead.

- [ ] **Step 1: Wallet** (`wallet/page.tsx`)
  - `rowActions={[ … ]}` (line 381) becomes `rowActions={can('money.act') ? [ … ] : undefined}`.
  - `<WalletV2BonusPushButton />` (line 330) becomes `{can('money.act') && <WalletV2BonusPushButton />}`.
  - The CSV export stays: it reads.

- [ ] **Step 2: FleetReview takes a `canReview` prop** (`components/FleetReview.tsx`)
  - Props (line 18):
    ```tsx
    interface Props {
      corporateAccountId: string;
      adminUserId: string;
      /** Shows approve and reject (fleets.review). Without it the list is read-only (00668). */
      canReview?: boolean;
    }
    ```
  - Line 66: `export function FleetReview({ corporateAccountId, adminUserId, canReview = true }: Props) {`.
  - Line 237: `{m.status === 'pending_review' && (` becomes `{canReview && m.status === 'pending_review' && (`.

- [ ] **Step 3: Business detail** (`businesses/[id]/page.tsx`)
  - After `const { can } = usePanelCan();` add:
    ```tsx
      // A fleet account is fleets.review, a corporate client account corporate.clients (00668).
      const canReviewAccount = (isFleet: boolean) => (isFleet ? can('fleets.review') : can('corporate.clients'));
    ```
  - Line 181: `{account.status === 'pending' && (` becomes `{canReviewAccount(Boolean(account.is_fleet_owner || hasFleet)) && account.status === 'pending' && (`.
  - Line 199: `{account.status === 'approved' && (` becomes `{can('corporate.clients') && account.status === 'approved' && (`.
  - Line 208: `{account.status === 'suspended' && (` becomes `{can('corporate.clients') && account.status === 'suspended' && (`.
  - In the commission block (line 282 on), wrap `<div className="flex items-center gap-2">` (the input, the `%` and the Guardar button) in `{can('corporate.clients') && ( … )}`. The current-commission line stays.
  - Line 326 becomes `<FleetReview corporateAccountId={account.id} adminUserId={adminUserId} canReview={can('fleets.review')} />`.

- [ ] **Step 4: Fraud** (`fraud/page.tsx`): `rowActions={[ … ]}` (line 200) becomes `rowActions={can('moderation.act') ? [ … ] : undefined}`.

- [ ] **Step 5: Cancellations**
  - `cancellations/page.tsx`: wrap the "Re-escanear" `<button … onClick={() => void rescan()}>` (line 191) in `{can('moderation.act') && ( … )}`.
  - `cancellations/[id]/page.tsx`: the actions container `<div className="flex flex-wrap gap-2">` (line 145) becomes `{can('moderation.act') && ( <div className="flex flex-wrap gap-2"> … </div> )}`.

- [ ] **Step 6: Support** (`support/page.tsx`)
  - After `const { can } = usePanelCan();` add `  const canReply = can('tickets.act');`.
  - The two status buttons: wrap `<div className="flex gap-1.5">` (line 297) in `{canReply && ( … )}`.
  - The reply bar: wrap `<div className="flex items-center gap-2 border-t border-line px-4 py-3">` (line 351) in `{canReply && ( … )}`.
  - Marketing keeps both: it has `tickets.act`.

- [ ] **Step 7: Assist page, read-only for the operator**
  - `components/support/AssistActiveRide.tsx`: add a prop `allowed` to the destructured props and its type:
    ```tsx
      allowed = true,
    }: {
      ctx: ActiveRideContext;
      now: number;
      /** Reloads the page; the buttons stay disabled until it settles. */
      onChanged: () => Promise<void>;
      /** Shows the advance, complete and release buttons (rides.act). */
      allowed?: boolean;
    }) {
    ```
    Then line 364 `{hasActions && (` becomes `{allowed && hasActions && (`.
  - `components/support/AssistCandidates.tsx`: add `/** Shows the offer and assign buttons (rides.act). */ allowed?: boolean;` to `Props`, destructure `allowed = true`, and wrap the two buttons (send offer, line ~219, and assign, line ~227) in `{allowed && ( <> … </> )}`. The WhatsApp and call links stay: the operator can still reach a driver.
  - `app/rides/[id]/assist/page.tsx`:
    - add `  const canAssist = can('rides.act');` after `const { can } = usePanelCan();`;
    - line 208 becomes `{active && <AssistActiveRide ctx={active} now={now} onChanged={load} allowed={canAssist} />}`;
    - pass `allowed={canAssist}` to `<AssistCandidates … />` (line 291);
    - line 298 becomes `{canAssist && <AssistServiceChange ride={ride} configs={configs} proposalLine={proposalLine} onChanged={load} />}`.

- [ ] **Step 8: Promotions** (`promotions/page.tsx`)
  - Line 101-102: replace
    ```tsx
      const { role } = usePanelRole();
      const isMarketing = menuRole(role) === 'marketing';
    ```
    with
    ```tsx
      const { can } = usePanelCan();
      // Marketing and admins write promotions; only admins see what waits for approval (00668).
      const canWrite = can('promotions.write');
      const canApprove = can('promotions.approve');
    ```
  - Remove the now unused imports of `usePanelRole` and `menuRole` from this file.
  - Line 129: `if (!isMarketing) setPendingCount(…)` becomes `if (canApprove) setPendingCount(…)`. Line 136's dependency `isMarketing` becomes `canApprove`.
  - Line 565: `{!isMarketing && pendingCount > 0 && (` becomes `{canApprove && pendingCount > 0 && (`.
  - Line 551, the header button: `{!showForm && (` becomes `{canWrite && !showForm && (`.
  - The empty state's `action: { … }` (line 780) becomes `action: canWrite ? { … } : undefined,`.
  - `rowActions={[ … ]}` (line 792) becomes `rowActions={canWrite ? [ … ] : undefined}`.
  - Run `git grep -n "isMarketing" -- apps/admin/src/app/promotions/page.tsx`; expected: no output.

- [ ] **Step 9: Referrals**
  - `referrals/page.tsx`:
    - lines 28-29 (`usePanelRole` and `isMarketing`) become `  const { can } = usePanelCan();`;
    - remove the unused `usePanelRole` and `menuRole` imports;
    - line 251 `rowActions={isMarketing ? undefined : [` becomes `rowActions={!can('referrals.rewards') ? undefined : [`;
    - line 204 becomes `<ReferralAmountsCard readOnly={!can('referrals.amounts')} />`.
  - `components/referrals/ReferralAmountsCard.tsx`:
    - line 61 becomes `export function ReferralAmountsCard({ readOnly = false }: { readOnly?: boolean } = {}) {`;
    - the input's `disabled={!draft || saving}` becomes `disabled={readOnly || !draft || saving}`;
    - wrap the buttons row `<div className="flex flex-wrap items-center justify-end gap-2">` (with "Descartar cambios" and "Guardar montos") in `{!readOnly && ( … )}`.

- [ ] **Step 10: Home** (`app/page.tsx`)
  - Add `import { usePanelCan } from '@/lib/usePanelCan';`.
  - Inside `DashboardPage`, after `const { email } = useAdminUser();`, add:
    ```tsx
      const { can } = usePanelCan();
      // The auto-actions card reads the audit log (00668: not for the operator).
      const canReadAudit = can('audit.read');
    ```
  - Line 118 `          adminService.getRecentAutoActions(6).catch(() => [] as AdminAction[]),` becomes
    ```tsx
              canReadAudit ? adminService.getRecentAutoActions(6).catch(() => [] as AdminAction[]) : Promise.resolve([] as AdminAction[]),
    ```
  - The fetch effect's dependency list (line 149, `}, []);`) becomes `}, [canReadAudit]);`.
  - Wrap the "Automatismos" `<SectionCard … >` (line 387) in `{canReadAudit && ( … )}`.

- [ ] **Step 11: Type-check and lint the panel**

Run: `pnpm --filter @tricigo/admin exec tsc --noEmit && pnpm --filter @tricigo/admin lint`
Expected: no errors and no new warnings.

- [ ] **Step 12: Commit**

```bash
git add apps/admin/src
git commit -m "feat(admin): hide money, moderation, support and assist actions by capability"
```

---

### Task 6: Ride detail reads a delivery without its code for the operator

**Files:**
- Modify: `packages/api/src/services/admin.service.ts:1826-1833`
- Test: `packages/api/src/services/__tests__/admin.test.ts` (inside `describe('getRideDetail')`)

- [ ] **Step 1: Write the failing test.** Add inside `describe('getRideDetail', () => {` after the second `it`:

```ts
    it('reads a cargo delivery through ops_delivery_details when delivery_details shows nothing (operator, 00668)', async () => {
      const ride = { id: 'r-3', driver_id: null, customer_id: 'u-3', ride_mode: 'cargo' };
      const opsRow = { ride_id: 'r-3', recipient_name: 'Rosa', delivery_otp_validated_at: null };

      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: ride, error: null });
      const chain2 = createMockQueryChain({ data: [], error: null });
      const chain3 = createMockQueryChain();
      chain3.maybeSingle.mockResolvedValue({ data: null, error: null });
      const chain4 = createMockQueryChain();
      chain4.single.mockResolvedValue({ data: { full_name: 'Carl', phone: '555-4' }, error: null });
      const chainDd = createMockQueryChain();
      chainDd.maybeSingle.mockResolvedValue({ data: null, error: null });
      const chainOps = createMockQueryChain();
      chainOps.maybeSingle.mockResolvedValue({ data: opsRow, error: null });
      const chainMsgs = createMockQueryChain({ data: [], error: null });

      mockFrom
        .mockReturnValueOnce(chain1)    // rides
        .mockReturnValueOnce(chain2)    // ride_transitions
        .mockReturnValueOnce(chain3)    // ride_pricing_snapshots
        .mockReturnValueOnce(chain4)    // users (customer)
        .mockReturnValueOnce(chainDd)   // delivery_details: nothing for an operator
        .mockReturnValueOnce(chainOps)  // ops_delivery_details
        .mockReturnValueOnce(chainMsgs); // ride_messages

      const result = await adminService.getRideDetail('r-3');

      expect(mockFrom).toHaveBeenCalledWith('ops_delivery_details');
      expect(result.delivery).toEqual(opsRow);
    });

    it('does not read ops_delivery_details when delivery_details returns the row (admin)', async () => {
      const ride = { id: 'r-4', driver_id: null, customer_id: 'u-4', ride_mode: 'cargo' };
      const ddRow = { ride_id: 'r-4', recipient_name: 'Rosa', delivery_otp: '4821' };

      const chain1 = createMockQueryChain();
      chain1.single.mockResolvedValue({ data: ride, error: null });
      const chain2 = createMockQueryChain({ data: [], error: null });
      const chain3 = createMockQueryChain();
      chain3.maybeSingle.mockResolvedValue({ data: null, error: null });
      const chain4 = createMockQueryChain();
      chain4.single.mockResolvedValue({ data: { full_name: 'Carl', phone: '555-4' }, error: null });
      const chainDd = createMockQueryChain();
      chainDd.maybeSingle.mockResolvedValue({ data: ddRow, error: null });
      const chainMsgs = createMockQueryChain({ data: [], error: null });

      mockFrom
        .mockReturnValueOnce(chain1)
        .mockReturnValueOnce(chain2)
        .mockReturnValueOnce(chain3)
        .mockReturnValueOnce(chain4)
        .mockReturnValueOnce(chainDd)
        .mockReturnValueOnce(chainMsgs);

      const result = await adminService.getRideDetail('r-4');

      expect(mockFrom).not.toHaveBeenCalledWith('ops_delivery_details');
      expect(result.delivery).toEqual(ddRow);
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/admin.test.ts -t "getRideDetail"`
Expected: the first new test FAILS. `ops_delivery_details` is never read, and `result.delivery` is null. The second passes.

- [ ] **Step 3: Implement.** In `packages/api/src/services/admin.service.ts`, replace

```ts
    if (ride.ride_mode === 'cargo') {
      const { data: dd } = await supabase
        .from('delivery_details')
        .select('*')
        .eq('ride_id', rideId)
        .maybeSingle();
      delivery = (dd as DeliveryDetails) ?? null;
    }
```

with

```ts
    if (ride.ride_mode === 'cargo') {
      const { data: dd } = await supabase
        .from('delivery_details')
        .select('*')
        .eq('ride_id', rideId)
        .maybeSingle();
      let row: unknown = dd;
      // An operator cannot read delivery_details (00668): it reads the same row without the
      // delivery code through ops_delivery_details, and the page shows "—" for the code.
      if (!row) {
        const { data: opsRow } = await supabase
          .from('ops_delivery_details')
          .select('*')
          .eq('ride_id', rideId)
          .maybeSingle();
        row = opsRow;
      }
      delivery = (row as DeliveryDetails) ?? null;
    }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tricigo/api exec vitest run src/services/__tests__/admin.test.ts`
Expected: PASS, every test in the file.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/admin.service.ts packages/api/src/services/__tests__/admin.test.ts
git commit -m "feat(api): ride detail reads a delivery without its code for the operator"
```

---

### Task 7: E-mail templates: invitation label and the digest's pending block

**Files:**
- Modify: `supabase/functions/_shared/email-templates/team_invitation.ts:22-26` and its test (lines 61-66)
- Modify: `supabase/functions/_shared/email-templates/team_daily_digest.ts:1-8,136-138,270-285` and its test

- [ ] **Step 1: Write the failing tests**
  - In `team_invitation.test.ts`, replace the test at lines 61-69 with:
    ```ts
      it('labels the four roles and leaves out an unknown expiry', () => {
        expect(['super_admin', 'admin', 'marketing', 'operator'].map(teamRoleLabel)).toEqual([
          'Superadministrador',
          'Administrador',
          'Marketing',
          'Operador',
        ]);
        expect(formatInvitationExpiry('nope')).toBe('');
        expect(teamInvitationHtml({ ...DATA, expires_at: 'nope' })).not.toContain('vence');
      });
    ```
  - In `team_daily_digest.test.ts`, add after the test `'marketing sees every ride number and breakdown but no money and no pending work'`:
    ```ts
      it('an operator sees the pending work but no money (00668)', () => {
        const html = teamDailyDigestHtml({ ...base, role: 'operator' });
        expect(html).toContain('Pendiente ahora');
        expect(html).toContain('Conductores esperando aprobaci');
        expect(html).toContain('Disputas abiertas');
        expect(html).not.toContain('Cobrado en viajes');
        expect(html).not.toContain('CUP');
      });
    ```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/_shared/email-templates/team_invitation.test.ts ../../supabase/functions/_shared/email-templates/team_daily_digest.test.ts`
Expected: FAIL. `teamRoleLabel('operator')` returns 'Equipo', and the operator gets no "Pendiente ahora".

- [ ] **Step 3: Implement**
  - `team_invitation.ts`: `ROLE_LABELS` gains `  operator: 'Operador',` after `marketing`.
  - `team_daily_digest.ts`:
    - header comment lines 6-7 become: `// team_daily_metrics(day) returns. Marketing never gets the Money and Pending blocks, the operator` / `// gets Pending but not Money (00668); any other role gets the marketing version.`;
    - after `seesMoney` add:
      ```ts
      /** Admins and operators see what is waiting for them; marketing does not (00668). */
      export function seesPending(role: string): boolean {
        return seesMoney(role) || role === 'operator';
      }
      ```
    - split the block at lines 270-285 into two: the money `heading` and `totalsTable` stay under `if (seesMoney(d.role)) { … }`, and the pending part moves under its own `if (seesPending(d.role)) { const p = m.pending; parts.push(heading('Pendiente ahora')); parts.push(table(…)); }`, its body unchanged.

- [ ] **Step 4: Run the tests**

Run: the command of Step 2, then `pnpm --filter @tricigo/api exec vitest run ../../supabase/functions/send-team-digest`
Expected: PASS everywhere. The digest handler tests still pass: they render admin and marketing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/email-templates
git commit -m "feat(email): operator label in invitations and pending block in its digest"
```

---

### Task 8: The enum value (00667)

**Files:**
- Create: `supabase/migrations/00667_operator_role_enum.sql`

- [ ] **Step 1: Re-check the number** (commands in "Before you start"). Expected: 00667 and 00668 free on master and in open PRs.

- [ ] **Step 2: Write the file**

```sql
-- ============================================================
-- 00667 — operator role: the enum value
--
-- Spec: docs/superpowers/specs/2026-10-25-operator-role-design.md
-- A value added by ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it
-- (same split as 00641/00642), so everything that uses 'operator' lives in 00668.
-- On its own this changes nothing: no account has the role until a super admin invites one.
-- ============================================================
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'operator';
```

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00667_operator_role_enum.sql
git commit -m "feat(db): operator value of user_role (00667)"
```

---

### Task 9: The migration (00668)

**Files:**
- Create: `supabase/migrations/00668_operator_role_base.sql` (from the draft)

The draft is complete. Read it before moving it: every section's comment says what it does.

| § | What it does |
|---|---|
| guard | aborts without 00667 |
| 1 | `is_operator()`, `is_ops_staff()`, EXECUTE for anon, authenticated, service_role |
| 2 | 33 `<table>_select_operator` policies, `v_admin_select` on vehicles widened to `is_ops_staff()`, three storage policies |
| 3 | the seven panel views recreated from their deparsed text with the operator in the gate, panel_rides "staff" list; new `ops_delivery_details` view without `delivery_otp`, REVOKE ALL then GRANT SELECT to authenticated and service_role |
| 4 + 5 | one md5-guarded patch loop over 29 functions (read gates, role lists, team), then the team_invitations CHECK replaced |
| 6 | `_sos_staff_alert()` and its AFTER INSERT trigger |
| 7 | CRLF cleanup of the three created functions |
| 8 | the self-check block |

- [ ] **Step 1: Move the draft**

```bash
git mv docs/superpowers/plans/2026-10-25-operator-role-base/00668_operator_role_base.sql supabase/migrations/00668_operator_role_base.sql
```

- [ ] **Step 2: Run the repo's static checks on it**

Run: `pnpm check:migration-grants && pnpm test:migration-grants`
Expected: PASS. `ops_delivery_details` is a new view with `GRANT SELECT … TO service_role`. The panel views are recreated through `EXECUTE format(...)`, which the checker skips by design.

Run: `pnpm --filter @tricigo/utils exec vitest run src/__tests__/copyTuteo.test.ts`
Expected: PASS. The two user-facing strings ("Alguien pidió ayuda de emergencia. Abre el panel para atenderla." and "El rol tiene que ser superadministrador, administrador, marketing u operador.") use tú.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00668_operator_role_base.sql
git commit -m "feat(db): operator role reads, role lists and SOS push (00668)"
```

---

### Task 10: The rehearsal scaffold from prod

**Files:**
- Create: `supabase/tests/00668/capture-prod.sql`, `supabase/tests/00668/stubs.sql`, `supabase/tests/00668/seed.sql` (from the drafts)
- Create: `supabase/tests/00668/prod-objects.sql` (generated)

`capture-prod.sql` builds the scaffold from prod's catalogue:
- every public enum, with `user_role` without 'operator';
- the tables the pages and the migration touch, with columns, simple defaults, the RLS flag and the API roles' grants;
- every function the migration patches, the never-opened money and team functions, and what they and the policies call, two calls deep, byte for byte, with their EXECUTE grants;
- the panel views and `driver_churn_risk`;
- the policies whose functions and tables are all in the scaffold;
- the ride transition trigger and the `valid_transitions` rows.

It was run on prod on 2026-10-25. It produced ~293 KB: 63 tables, 82 functions, 166 policies, 0 C-language functions. Two storage write policies were skipped (`driver_contracts_service_write`, `receipts_service_write`) because they need objects outside the scaffold.

- [ ] **Step 1: Move the drafts**

```bash
mkdir -p supabase/tests/00668
git mv docs/superpowers/plans/2026-10-25-operator-role-base/capture-prod.sql supabase/tests/00668/capture-prod.sql
git mv docs/superpowers/plans/2026-10-25-operator-role-base/stubs.sql supabase/tests/00668/stubs.sql
git mv docs/superpowers/plans/2026-10-25-operator-role-base/seed.sql supabase/tests/00668/seed.sql
```

- [ ] **Step 2: Generate `prod-objects.sql`.** This must run BEFORE 00667 is applied in prod, so the captured functions still have the bodies the migration expects. Through the Supabase MCP `execute_sql` (read-only), the output is ~293 KB, larger than a tool reply, so use the padding trick from CLAUDE.md (00640):
  1. Wrap the file's final `SELECT … AS scaffold` as `SELECT json_build_object('scaffold', scaffold, 'pad', repeat('#', 150000)) FROM ( <the query from WITH RECURSIVE to AS scaffold> ) q;`. Keep the file's first line, `SET LOCAL search_path = pg_catalog;`.
  2. The tool saves the reply to a file. Decode it with Python: the outer JSON, then the JSON inside `<untrusted-data-…>`, then the `scaffold` field. Write it as UTF-8 with LF line endings to `supabase/tests/00668/prod-objects.sql`.
  3. Check the decoded file: it starts with `-- Generated by supabase/tests/00668/capture-prod.sql on 2026-…`, and `grep -c "CREATE OR REPLACE FUNCTION" supabase/tests/00668/prod-objects.sql` prints a number in the 80s.

  If the capture is run after 00667 or 00668 reached prod, S0.1 in the rehearsal fails. That is the signal to capture again from a database without them; do not edit the md5 lists.

- [ ] **Step 3: Set up local Postgres** as CLAUDE.md § "En Windows, sin sandbox" describes:
  - portable PG 16 binaries in the scratchpad;
  - `initdb -U pgtest -A trust -E UTF8 --no-locale`;
  - a free port, checked with `netstat -ano | grep LISTENING`;
  - `pg_ctl … start`.

  Export `PGBIN=<…/pgsql/bin> PGPORT=<port> PYTHON=python`.

- [ ] **Step 4: Check that the scaffold loads**

```bash
"$PGBIN/psql" -h 127.0.0.1 -p $PGPORT -U pgtest -d postgres -c "CREATE DATABASE scaffold_check"
"$PGBIN/psql" -h 127.0.0.1 -p $PGPORT -U pgtest -d scaffold_check -v ON_ERROR_STOP=1 -q -f supabase/tests/00668/stubs.sql
"$PGBIN/psql" -h 127.0.0.1 -p $PGPORT -U pgtest -d scaffold_check -v ON_ERROR_STOP=1 -q -c "SET ROLE postgres" -f supabase/tests/00668/prod-objects.sql
"$PGBIN/psql" -h 127.0.0.1 -p $PGPORT -U pgtest -d postgres -c "DROP DATABASE scaffold_check"
```

Expected: no ERROR.
- If an object fails because of something the capture does not cover, fix the cause in `capture-prod.sql` or `stubs.sql` and generate again. Typical causes: a type from an extension, or a function referenced only in a view. Never edit `prod-objects.sql` by hand.
- Add a stub only for something a test runs. With `check_function_bodies = off`, a function body that calls something missing loads anyway.

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/00668
git commit -m "test(db): 00668 rehearsal scaffold captured from prod"
```

---

### Task 11: The rehearsal: RED, then GREEN

**Files:**
- Create: `supabase/tests/00668/run.sh` (from the draft)

The runner builds `pr668` from stubs, prod objects, 00667 and the seed. It runs:

| Group | What it checks |
|---|---|
| S0 | the scaffold is prod: patched bodies, view definitions, `is_admin()`, the enum value, the two money functions the scaffold lacks, and no function with the literal `'operator'` before 00668 |
| T1 | helpers, by role and as anon |
| T2 | the operator reads all 33 tables, vehicles and only the three buckets |
| T3 | the operator reads the seven views like an admin; `ops_delivery_details` without the code, nothing for a customer, permission denied for anon; an operator's cancel counts as staff |
| T4 | customer, marketing and admin read exactly what they read before |
| T5 | each of the 18 read gates refuses a customer and lets the operator through; the live fleet lists the online driver; marketing still has no fleet |
| T6 | the operator cancels its own search as a customer |
| T7 | a help alert reaches active admins, super admins and operators, not marketing or an inactive operator |
| T8 | SOS: push recipients and incident link, one push per person and minute, not to the reporter, not for other incident types, a failing push or a missing key never refuses the SOS and is logged, the title (name and initial, the test prefix, the fallback), a lock wait on the rate limit, an SOS without a reporter |
| T9 | team: rank, invite as operator, list, move marketing to operator, digest recipients |
| T10 | level, promotion and blocking stay closed to the operator |
| T11 | the operator's 177 write probes give the same result before and after 00668, and `ops_delivery_details` refuses every write |
| G1-G7 | the patched and created bodies, the panel views, the functions with the literal `'operator'`, the SOS trigger and the settings of its function, and the reset of `lock_timeout` (GREEN only) |
| G0 | a snapshot of everything else unchanged |
| C | a CRLF copy on a fresh database |
| N0-N15b | negative proofs that each self-check really aborts |

- [ ] **Step 1: Move the runner**

```bash
git mv docs/superpowers/plans/2026-10-25-operator-role-base/run.sh supabase/tests/00668/run.sh
rmdir docs/superpowers/plans/2026-10-25-operator-role-base
git ls-files --eol supabase/tests/00668/ supabase/migrations/00668_operator_role_base.sql
```

Expected: every file shows `w/lf` (`.gitattributes` forces LF there). If one shows `w/crlf`, re-checkout it as CLAUDE.md "Trampa CRLF" describes before running anything.

- [ ] **Step 2: RED**

Run: `PGBIN=$PGBIN PGPORT=$PGPORT PYTHON=python bash supabase/tests/00668/run.sh none`
Expected:
- **Pass:** S0.1 to S0.6, T3.e (the view does not exist yet, so it has no code column), the customer half of every T5 gate, T5.m, T8.4, T10.1 to T10.3 and T11.0 to T11.2 (the write probes are the same before and after). Measured on 2026-10-26: PASS 34, FAIL 92.
- **Fail:** everything else.
- **Exit code:** non-zero.
- **Write down the counts** (PASS n, FAIL m) for the PR body.

- [ ] **Step 3: GREEN**

Run: `PGBIN=$PGBIN PGPORT=$PGPORT PYTHON=python bash supabase/tests/00668/run.sh supabase/migrations/00668_operator_role_base.sql`
Expected: `FAIL 0`, exit code 0. Measured on 2026-10-26: PASS 163. That covers M1 and M2 (applied twice), S0, T1-T11, G0-G7, C2-C5 and N0-N15b.

- [ ] **Step 4: If something fails, fix the cause, not the test**
  - **A wrong expectation from deparsing** (the exact text of a policy `qual`, a storage policy, the team CHECK, or a view tail) means the migration's check block expects text Postgres prints differently. Print the real text from `pr668`, which the runner keeps, and fix the constant in BOTH the migration's §8 and, if it is there, the runner. A sample query:
    ```bash
    "$PGBIN/psql" -h 127.0.0.1 -p $PGPORT -U pgtest -d pr668 -c "SET search_path = pg_catalog; SELECT policyname, qual FROM pg_policies WHERE policyname LIKE '%operator'"
    ```
  - **A body md5 mismatch** in S0 means the capture is not prod; in G1 or G2, the file is not the one that was measured. Do not change the expected md5s to make the test pass. Find which body differs (`pg_get_functiondef`) and why.
  - **The rehearsal's T-tests are the requirements from the spec.** If one cannot pass without changing a decision in the spec, stop and ask.

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/00668 supabase/migrations/00668_operator_role_base.sql
git commit -m "test(db): 00668 rehearsal, RED without it and GREEN applied twice"
```

---

### Task 12: Repo-wide verification

- [ ] **Step 1: Types, lint and tests**

Run, from the repo root:

```bash
pnpm check-types
pnpm lint
pnpm exec turbo run test --force
pnpm check:i18n
pnpm check:migration-grants
```

Expected: all pass. Use `--force` on the tests: a cached turbo run can replay an old green (CLAUDE.md "turbo test cache replay").

- [ ] **Step 2: The admin build lists the middleware**

Run: `pnpm --filter @tricigo/admin build`
Expected: the build succeeds and its output contains the line `ƒ Middleware`.

- [ ] **Step 3: See the operator's panel locally.** Use the admin dev server through the Browser pane with `preview_start`; do not start servers from Bash.
  1. Create a `.claude/launch.json` entry for `@tricigo/admin` if there is none.
  2. Copy `apps/admin/.env.local` from the main checkout into this worktree.
  3. Sign in as an admin.
  4. To see the operator UI without changing any account, set the cookie the menus read in the browser console: `document.cookie = 'tricigo_panel_role=operator; path=/'`, then reload. The middleware rewrites it on every page, so this only shows the menus and buttons; the data still comes as the admin.
  5. Check: the menu shows only the operator's pages; `/drivers/<id>` has no Acciones menu and no verify/upload/generate buttons; `/wallet` has no Aprobar/Rechazar; the header says "Operador"; the home page has no Automatismos card.
  6. Take a screenshot for the PR.

---

### Task 13: Document it in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`. Add a section after "### Rol `marketing` en el panel admin (00641/00642, PR #1115)" and its subsection.

The section committed to CLAUDE.md is longer than the template below: it adds what the reviews found (the 29 patched functions, the earnings note, `share_token`, the advisor ERROR for `ops_delivery_details`, the SOS title and lock timeout, the literal `'operator'` checks, and how to apply the file).

- [ ] **Step 1: Add this section** (Spanish, the house style of CLAUDE.md):

````markdown
### Rol `operator` en el panel admin (00667/00668, entrega 1 de 4)

Una persona de operaciones: viajes en vivo, soporte, alta de conductores, cuentas y moderación. Nunca toca dinero, configuración ni equipo. Diseño: `docs/superpowers/specs/2026-10-25-operator-role-design.md`. Plan de esta entrega: `docs/superpowers/plans/2026-10-25-operator-role-base.md`. Ensayo: `supabase/tests/00668/run.sh` (RED sin la migración; GREEN aplicada dos veces, copia CRLF y pruebas negativas de cada autochequeo).

- **Qué hace esta entrega:** el operador entra (invitado desde `/equipo`), abre sus páginas y lee todo lo que muestran, recibe los avisos de soporte y SOS y el resumen diario sin el bloque de dinero. No actúa sobre nada todavía: cada botón de acción se oculta por capacidad y el servidor lo rechaza por su cuenta. Las entregas 2 (alta de conductores y flotas), 3 (viajes en vivo) y 4 (soporte, cuentas y moderación) abren las acciones con funciones `ops_*`.
- **Helpers:** `is_operator()` (solo operator) e `is_ops_staff()` (admin, super_admin u operator). Plpgsql con el `RETURN false` sin sesión de 00592, y EXECUTE para anon: las políticas los llaman también al leer como anon. `is_admin()` no cambia.
- **Lecturas:** una política `<tabla>_select_operator` (SELECT, `{authenticated}`, `USING ((SELECT public.is_operator()))`) en 33 tablas, `v_admin_select` de `vehicles` pasa a `is_ops_staff()` (00644 no admite una tercera política), y tres políticas de storage (`driver-documents`, `driver-contracts`, `receipts`). Las siete vistas `panel_*` suman al operador en su verja. `ops_delivery_details` es `delivery_details` sin `delivery_otp`: el operador nunca ve el código de entrega. **El autochequeo de 00668 aborta si aparece otra política, función o vista que mencione al operador fuera de su lista**: una tabla nueva que el operador deba leer se agrega en una migración que también actualice esa lista.
- **Panel:** `panelCanAct` ya no existe. Las páginas preguntan `usePanelCan().can('<capacidad>')` (`packages/utils/src/adminPanelAccess.ts`). El operador tiene en esta entrega solo `detail.full`: ve el detalle completo (GPS, documentos, chat, billetera) y ningún botón. Una página nueva con acciones pregunta por la capacidad que corresponde; no por el rol.
- **Transiciones de viaje:** `enforce_ride_transition` trata al operador como `customer`, igual que a marketing: viaja como pasajero sin transiciones de admin. La entrega 3 lo convierte en `admin` solo dentro de una función `ops_*` sobre ese viaje.
- **Avisos:** `_support_alert` suma al operador. `_sos_staff_alert` (trigger `incident_reports_sos_staff_alert`, AFTER INSERT de un SOS) manda un push a operadores y admins activos, con el enlace al incidente, por `cron_http_post` (etiqueta `sos-staff-alert`), uno por persona que reporta por minuto, y nunca rechaza el SOS: un fallo queda en `rpc_attempt_log` (`_sos_staff_alert`, `alert_failed`).
- **Equipo:** el operador entra al CHECK de `team_invitations`, a las listas de rol de las funciones de equipo y a `_team_role_rank` con 1, igual que marketing. Pasar de marketing a operador se hace con "Cambiar rol": aceptar una invitación nunca baja un rol.
- **Cuerpos tras 00668** (md5 de `prosrc`): una migración que redefina cualquiera de las 29 funciones parcheadas parte del cuerpo vivo; los valores están en `supabase/tests/00668/run.sh` (`NEW_BODIES`). Re-correr 00628, 00660, 00485, 00629, 00488 o las vistas de 00663, que usan `CREATE OR REPLACE` sin guarda, devolvería esas verjas a solo admin sin error.
- **Estado (2026-10-25):** 00667 y 00668 no están aplicadas en prod.
````

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): operator role, delivery 1"
```

---

### Task 14: Pull request and rollout

Each step below needs the founder's OK in chat. Ask for it step by step, as CLAUDE.md requires for pushes, merges and production changes.

- [ ] **Step 1: Push and open the PR** (after OK).
  - Title: `feat: operator panel role, delivery 1 (00667/00668)`.
  - Body from a temp file (`gh pr create --body-file`), including:
    - what the operator sees and does not;
    - the RED and GREEN counts;
    - the screenshot from Task 12;
    - "00667 and 00668 are not applied yet";
    - the rollout below.
  - Then bind it with the ccd_pr tools.
- [ ] **Step 2: Rehearse in prod inside a rolled-back block** (after OK). MCP `execute_sql` cannot run 00667 and 00668 together (the enum value), so:
  1. Ask to apply **00667** for real by MCP (`apply_migration`). It is one `ALTER TYPE`, harmless on its own.
  2. Rehearse 00668 in a `DO $probe$ … $probe$` block that `EXECUTE`s the file and ends in `RAISE EXCEPTION`, so nothing stays:
     - make an existing test account an operator inside the block (the demo passenger `+5355550100`, with `UPDATE users SET role = 'operator'`);
     - as that account (`set_config('request.jwt.claim.sub', …, true)` plus `SET LOCAL ROLE authenticated` via `EXECUTE`), count `rides` and `panel_rides`, call `get_admin_dashboard_metrics()` and `admin_get_online_fleet()`;
     - insert an SOS as the owner and read back `cron_http_calls` for `sos-staff-alert`. pg_net's queue is transactional, so the rollback cancels the HTTP call.
  3. The file has backslashes (`'panel\_%'`, `'%\_operator'`, the regex `'is_(operator|ops_staff)\('`). Send it as CLAUDE.md describes for 00663: every `\` replaced by `@@BS@@`, the text inside `replace($m$…$m$, '@@BS@@', chr(92))`, and its `md5` compared with the file's before `EXECUTE`.
- [ ] **Step 3: Apply 00668** (after OK).
  - Try MCP `apply_migration` first, with the same `@@BS@@` wrapper.
  - The file has `DROP CONSTRAINT` (the team CHECK). If MCP waits for an approval that never shows twice, give the founder the SQL Editor steps from CLAUDE.md § "Aplicar migraciones pesadas por MCP": paste the file plus the `$crlf$` block is already inside it.
  - Verify by object:
    - the md5s of `NEW_BODIES` and of the three created functions;
    - `SELECT count(*) FROM pg_policies WHERE policyname LIKE '%\_select\_operator'` = 33, plus the three `storage_*_select_operator`;
    - the trigger `incident_reports_sos_staff_alert` enabled;
    - `ops_delivery_details` grants.
- [ ] **Step 4: Deploy the two template changes** (after OK). Deploy `send-email` (team invitation label) and `send-team-digest` (pending block) from an LF export of the tree, as CLAUDE.md describes (`git -c core.autocrlf=false archive`, then `npx supabase functions deploy <name> --project-ref lqaufszburqvlslpcuac` from the export). Afterwards, `functions download` both and diff them against master's files.
- [ ] **Step 5: Merge the PR** (after the founder writes "Sí, autorizo el squash-merge de #N"). Confirm the admin deploy finished (`gh run watch`), and that `https://admin.tricigo.com/login` answers 200.
- [ ] **Step 6: First real operator** (after OK).
  1. The founder invites an operator from `/equipo` with the role "Operador".
  2. Once accepted, the founder walks through, with the operator, the home page, a driver, a ride with its assist page and a ticket, and confirms that no money, settings or action button shows.
  3. Ask them to trigger nothing real. To check the SOS push, use the demo accounts and a rolled-back insert, not a real SOS.
- [ ] **Step 7: Update CLAUDE.md's "Estado" line** in a small docs PR. Replace "no están aplicadas en prod" with the date each one was applied, the `version` MCP recorded (or "SQL Editor, sin registro en `schema_migrations`"), and what Steps 3-5 verified by object.

---

## Notes from planning (refinements to the spec)

These came out of reading the code and prod while writing this plan. None changes a decision taken with the founder. They are already folded into the spec.

- **Capabilities.** The spec's `support.act` is split in two:
  - `tickets.act` (support tickets; marketing keeps it);
  - `cases.act` (incidents, disputes, lost items; marketing never had it).

  Also added: `pois.act` (admin only: marketing only reads POIs), `promotions.approve` (the pending strip and menu dot) and `corporate.clients`. `users.level` is not needed: the level selector already checks super admin. The push capabilities wait for delivery 4, with `/notifications`.
- **`/notifications` waits for delivery 4.** Its only use for the operator is pushing one person, which needs the `send-push` change of that delivery. Until then the operator does not open it.
- **`menuRole` keeps marketing as the fallback.** The spec said "no menu". A role that cannot be read shows the smallest menu; the middleware and the server still refuse everything else.
- **33 tables, not the spec's longer list.** The tables come from reading what each page actually loads:
  - `notification_log`, `notifications`, `user_devices` and `payment_intents` are not read by any operator page in this delivery;
  - `ride_waypoints` and `ride_location_events` are not read by the ride detail;
  - `customer_profiles` and `driver_outreach_log` are not read directly.
- **`get_corporate_employees`** joins the patched read gates: `/businesses/[id]` calls it.
- **The delivery without its code is a view,** `ops_delivery_details`, not a function: the ride detail reads it with the same query shape as `delivery_details`.
- **`BottomNav` does not change.** The operator is not marketing, so it gets the default four tabs (`/`, `/rides`, `/live-map`, `/support`), all of which it can open.
- **`storage.objects` is not locked up front** in 00668: its owner is Supabase's storage role. The three storage policies take their own lock under the same `lock_timeout`.
- **Inactive operators** keep reading for the life of their access token (up to 1 h), like admins today: `is_admin()`, `is_marketing()` and the new helpers do not look at `is_active`. The middleware signs them out of the panel within a minute.

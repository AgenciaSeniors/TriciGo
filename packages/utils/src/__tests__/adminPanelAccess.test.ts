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

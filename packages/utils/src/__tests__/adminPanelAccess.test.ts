import { describe, expect, it } from 'vitest';
import {
  MARKETING_HOME,
  MARKETING_ROUTES,
  PANEL_ROLE_COOKIE,
  canOpenPanelPath,
  isPanelRole,
  menuRole,
  panelHome,
  panelRoleFromCookies,
  type PanelRole,
} from '../adminPanelAccess';

describe('isPanelRole', () => {
  it('accepts the three panel roles', () => {
    for (const role of ['admin', 'super_admin', 'marketing']) expect(isPanelRole(role)).toBe(true);
  });

  it('rejects every other value', () => {
    for (const role of ['customer', 'driver', '', 'Admin', null, undefined, 42]) expect(isPanelRole(role)).toBe(false);
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
    for (const path of ['/', '/wallet', '/wallet/gifts', '/users', '/users/1', '/drivers', '/rides', '/settings',
      '/notifications', '/content', '/competitors', '/earnings', '/support']) {
      expect(canOpenPanelPath('marketing', path)).toBe(false);
    }
  });

  it('does not take a longer name for a sub-page', () => {
    expect(canOpenPanelPath('marketing', '/promotionsx')).toBe(false);
    expect(canOpenPanelPath('marketing', '/blog-admin')).toBe(false);
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
  it('sends marketing to the launch pulse and admins to the dashboard', () => {
    expect(panelHome('marketing')).toBe(MARKETING_HOME);
    expect(canOpenPanelPath('marketing', MARKETING_HOME)).toBe(true);
    expect(panelHome('admin')).toBe('/');
    expect(panelHome('super_admin')).toBe('/');
  });

  it('uses the least privileged menus when the role is unknown', () => {
    expect(menuRole(null)).toBe('marketing');
    expect(menuRole(undefined)).toBe('marketing');
    expect(menuRole('admin')).toBe('admin');
  });
});

describe('panelRoleFromCookies', () => {
  it('reads the role the middleware wrote', () => {
    expect(panelRoleFromCookies(`a=1; ${PANEL_ROLE_COOKIE}=marketing; b=2`)).toBe('marketing');
    expect(panelRoleFromCookies(`${PANEL_ROLE_COOKIE}=super_admin`)).toBe('super_admin');
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

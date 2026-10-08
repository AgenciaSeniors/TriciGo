import { describe, expect, it } from 'vitest';
import { MARKETING_PUSH_CATEGORIES, canSendPush, isAdminRole, isPanelStaffRole } from './panel-roles';

describe('panel roles', () => {
  it('knows the admin roles', () => {
    expect(isAdminRole('admin')).toBe(true);
    expect(isAdminRole('super_admin')).toBe(true);
    for (const role of ['marketing', 'customer', 'driver', null, undefined]) expect(isAdminRole(role)).toBe(false);
  });

  it('counts marketing as panel staff, nobody else outside the admins', () => {
    for (const role of ['admin', 'super_admin', 'marketing']) expect(isPanelStaffRole(role)).toBe(true);
    for (const role of ['customer', 'driver', '', null, undefined]) expect(isPanelStaffRole(role)).toBe(false);
  });

  it('lets an admin send any push, categorized or not', () => {
    expect(canSendPush('admin', 'ride_offer')).toBe(true);
    expect(canSendPush('super_admin', undefined)).toBe(true);
  });

  it("lets marketing send only its pages' content categories", () => {
    expect([...MARKETING_PUSH_CATEGORIES].sort()).toEqual(['announcement', 'blog', 'campaign', 'promo']);
    for (const category of MARKETING_PUSH_CATEGORIES) expect(canSendPush('marketing', category)).toBe(true);
    for (const category of ['ride_offer', 'system', 'sos', 'payment', 'news', undefined, null]) {
      expect(canSendPush('marketing', category)).toBe(false);
    }
  });

  it('never lets anyone else send', () => {
    expect(canSendPush('customer', 'campaign')).toBe(false);
    expect(canSendPush(null, 'campaign')).toBe(false);
  });
});

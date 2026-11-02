import { describe, expect, it } from 'vitest';
import {
  MARKETING_PUSH_CATEGORIES,
  MARKETING_PUSH_DATA_KEYS,
  canSendPush,
  isAdminRole,
  isOpsRole,
  isPanelRole,
  isPanelStaffRole,
  marketingPushData,
  pushDataForRole,
} from './panel-roles';

describe('panel roles', () => {
  it('counts the operator as operations staff, with the admins, and nobody else (00672)', () => {
    for (const role of ['admin', 'super_admin', 'operator']) expect(isOpsRole(role)).toBe(true);
    for (const role of ['marketing', 'customer', 'driver', '', null, undefined]) expect(isOpsRole(role)).toBe(false);
  });

  it('knows the four panel roles', () => {
    for (const role of ['admin', 'super_admin', 'marketing', 'operator']) expect(isPanelRole(role)).toBe(true);
    for (const role of ['customer', 'driver', '', null, undefined]) expect(isPanelRole(role)).toBe(false);
  });

  it('never opens bulk e-mail or campaigns to the operator', () => {
    expect(isPanelStaffRole('operator')).toBe(false);
  });

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

  it('lets the operator send one announcement to exactly one person (00673)', () => {
    expect(canSendPush('operator', 'announcement', ['u1'])).toBe(true);
    expect(canSendPush('operator', 'announcement', ['u1', 'u2'])).toBe(false);
    expect(canSendPush('operator', 'announcement', ['u1', 'u1'])).toBe(false);
    expect(canSendPush('operator', 'announcement', [])).toBe(false);
    expect(canSendPush('operator', 'announcement')).toBe(false);
    for (const category of ['campaign', 'promo', 'blog', 'system', 'ride', undefined]) {
      expect(canSendPush('operator', category, ['u1'])).toBe(false);
    }
  });
});

describe('pushDataForRole', () => {
  const data = { event: 'ride_assigned', ride_id: 'r1', deep_link: '/x' };

  it('keeps everything for an admin and for internal calls', () => {
    expect(pushDataForRole('admin', data)).toBe(data);
    expect(pushDataForRole(null, data)).toBe(data);
  });

  it("keeps marketing's content keys only", () => {
    expect(pushDataForRole('marketing', data)).toEqual({ deep_link: '/x' });
  });

  it('drops all of it for the operator', () => {
    expect(pushDataForRole('operator', data)).toEqual({});
  });
});

describe('marketingPushData', () => {
  it("keeps only the keys the panel's content pushes send", () => {
    expect([...MARKETING_PUSH_DATA_KEYS].sort()).toEqual(['content_id', 'content_type', 'deep_link']);
    expect(
      marketingPushData({
        deep_link: 'tricigo://home',
        content_type: 'promo',
        content_id: 'p1',
        event: 'ride_assigned',
        ride_id: 'r1',
        type: 'ride',
      }),
    ).toEqual({ deep_link: 'tricigo://home', content_type: 'promo', content_id: 'p1' });
  });

  it('drops values that are not strings', () => {
    expect(marketingPushData({ deep_link: { path: '/x' }, content_id: 7, content_type: 'blog' })).toEqual({
      content_type: 'blog',
    });
  });

  it('returns an empty object for missing or non-object data', () => {
    for (const data of [undefined, null, 'deep_link', 42, ['deep_link']]) expect(marketingPushData(data)).toEqual({});
  });

  it('ignores inherited keys', () => {
    expect(marketingPushData(Object.create({ deep_link: 'inherited' }))).toEqual({});
    const parsed = JSON.parse('{"__proto__": {"deep_link": "x"}, "content_type": "blog"}');
    expect(marketingPushData(parsed)).toEqual({ content_type: 'blog' });
  });
});

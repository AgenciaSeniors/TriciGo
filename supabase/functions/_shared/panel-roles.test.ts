import { describe, expect, it } from 'vitest';
import {
  MARKETING_PUSH_CATEGORIES,
  MARKETING_PUSH_DATA_KEYS,
  canSendPush,
  isAdminRole,
  isPanelStaffRole,
  marketingPushData,
} from './panel-roles';

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

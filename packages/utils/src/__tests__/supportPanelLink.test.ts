import { describe, it, expect } from 'vitest';
import { supportPanelLink } from '../supportPanelLink';

const RIDE = '7a28083f-dde9-4fb8-8ab8-25989fb196ef';
const URL = `https://admin.tricigo.com/rides/${RIDE}/assist`;

describe('supportPanelLink', () => {
  it('returns the assist page of a support push (help, wait and owner alerts)', () => {
    for (const event of ['support_help', 'support_wait', 'support_owner']) {
      expect(supportPanelLink({ type: 'system', event, ride_id: RIDE, url: URL })).toBe(URL);
    }
  });

  it('accepts the exact data the server stores (00683 _support_send)', () => {
    // Copied from a notifications row of 2026-11-17.
    expect(
      supportPanelLink({
        url: URL,
        type: 'system',
        event: 'support_help',
        ride_id: RIDE,
      }),
    ).toBe(URL);
  });

  it('ignores pushes that are not support alerts', () => {
    expect(supportPanelLink({ type: 'system', url: URL })).toBeNull();
    expect(supportPanelLink({ type: 'ride', event: 'ride_assigned', url: URL })).toBeNull();
    expect(supportPanelLink({ type: 'system', event: 'support_ride_update', url: URL })).toBe(URL);
  });

  it('returns null without a usable url', () => {
    expect(supportPanelLink(undefined)).toBeNull();
    expect(supportPanelLink(null)).toBeNull();
    expect(supportPanelLink('support_help')).toBeNull();
    expect(supportPanelLink({ event: 'support_help', ride_id: RIDE })).toBeNull();
    expect(supportPanelLink({ event: 'support_help', url: 42 })).toBeNull();
  });

  it('only opens the panel assist page, never another site or page', () => {
    const bad = [
      `http://admin.tricigo.com/rides/${RIDE}/assist`,
      `https://admin.tricigo.com.evil.example/rides/${RIDE}/assist`,
      `https://admin.tricigo.com@evil.example/rides/${RIDE}/assist`,
      `https://evil.example/?u=https://admin.tricigo.com/rides/${RIDE}/assist`,
      `https://tricigo.com/rides/${RIDE}/assist`,
      `https://admin.tricigo.com/users/${RIDE}`,
      `https://admin.tricigo.com/rides/${RIDE}/assist?next=https://evil.example`,
      `https://admin.tricigo.com/rides/${RIDE}/assist#x`,
      `https://admin.tricigo.com/rides/../settings/assist`,
      `https://admin.tricigo.com/rides/not-a-uuid/assist`,
      ` ${URL}`,
      `${URL}\n`,
      `javascript:alert(1)//${URL}`,
    ];
    for (const url of bad) {
      expect(supportPanelLink({ event: 'support_help', url })).toBeNull();
    }
  });

  it('accepts an upper-case ride id', () => {
    const upper = `https://admin.tricigo.com/rides/${RIDE.toUpperCase()}/assist`;
    expect(supportPanelLink({ event: 'support_wait', url: upper })).toBe(upper);
  });
});

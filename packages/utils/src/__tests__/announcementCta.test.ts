import { describe, it, expect } from 'vitest';
import {
  resolveAnnouncementCta,
  isValidAnnouncementCta,
  ANNOUNCEMENT_CTA_TARGETS,
} from '../announcementCta';

describe('resolveAnnouncementCta', () => {
  it('treats /(tabs) as a booking intent without a preselected service', () => {
    expect(resolveAnnouncementCta('/(tabs)')).toEqual({ kind: 'book' });
    expect(resolveAnnouncementCta('/(tabs)/index')).toEqual({ kind: 'book' });
  });

  it('treats /(tabs)?service=mensajeria as a booking intent with mensajeria preselected', () => {
    expect(resolveAnnouncementCta('/(tabs)?service=mensajeria')).toEqual({
      kind: 'book',
      service: 'mensajeria',
    });
  });

  it('accepts /book as a web-parity alias for the booking intent', () => {
    // The original bug stored '/book' (the web route). It must no longer 404 —
    // the handler now treats it as the in-app booking intent.
    expect(resolveAnnouncementCta('/book')).toEqual({ kind: 'book' });
    expect(resolveAnnouncementCta('/book?service=mensajeria')).toEqual({
      kind: 'book',
      service: 'mensajeria',
    });
  });

  it('ignores an unknown service slug (falls back to plain booking)', () => {
    expect(resolveAnnouncementCta('/(tabs)?service=teletransporte')).toEqual({ kind: 'book' });
  });

  it('routes to known in-app screens', () => {
    expect(resolveAnnouncementCta('/profile/referral')).toEqual({
      kind: 'route',
      path: '/profile/referral',
    });
    expect(resolveAnnouncementCta('/(tabs)/wallet')).toEqual({
      kind: 'route',
      path: '/(tabs)/wallet',
    });
    expect(resolveAnnouncementCta('/ride/share/abc')).toEqual({
      kind: 'route',
      path: '/ride/share/abc',
    });
  });

  it('returns none for an unknown /route so it can never push a 404', () => {
    expect(resolveAnnouncementCta('/book-now')).toEqual({ kind: 'none' });
    expect(resolveAnnouncementCta('/totally/made/up')).toEqual({ kind: 'none' });
  });

  it('opens external schemes via the system handler', () => {
    expect(resolveAnnouncementCta('https://tricigo.com/promo')).toEqual({
      kind: 'external',
      url: 'https://tricigo.com/promo',
    });
    expect(resolveAnnouncementCta('tel:+5350000000')).toEqual({
      kind: 'external',
      url: 'tel:+5350000000',
    });
    expect(resolveAnnouncementCta('tricigo://refer/ABC')).toEqual({
      kind: 'external',
      url: 'tricigo://refer/ABC',
    });
  });

  it('returns none for empty, whitespace, null or undefined', () => {
    expect(resolveAnnouncementCta(null)).toEqual({ kind: 'none' });
    expect(resolveAnnouncementCta(undefined)).toEqual({ kind: 'none' });
    expect(resolveAnnouncementCta('')).toEqual({ kind: 'none' });
    expect(resolveAnnouncementCta('   ')).toEqual({ kind: 'none' });
  });

  it('returns none for a bare token with no scheme and no leading slash', () => {
    expect(resolveAnnouncementCta('book')).toEqual({ kind: 'none' });
  });
});

describe('isValidAnnouncementCta', () => {
  it('accepts an empty value (announcement with no CTA button)', () => {
    expect(isValidAnnouncementCta('')).toBe(true);
    expect(isValidAnnouncementCta('   ')).toBe(true);
  });

  it('accepts every shipped admin target', () => {
    for (const target of ANNOUNCEMENT_CTA_TARGETS) {
      expect(isValidAnnouncementCta(target.value)).toBe(true);
    }
  });

  it('accepts external URLs', () => {
    expect(isValidAnnouncementCta('https://example.com')).toBe(true);
    expect(isValidAnnouncementCta('mailto:soporte@tricigo.com')).toBe(true);
  });

  it('rejects an unknown in-app route', () => {
    expect(isValidAnnouncementCta('/book-now')).toBe(false);
    expect(isValidAnnouncementCta('/does-not-exist')).toBe(false);
  });
});

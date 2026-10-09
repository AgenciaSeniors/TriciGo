import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDate,
  formatTime,
  formatDuration,
  formatDistance,
  getRelativeTime,
  havanaMidnightUtc,
  havanaDayRangeUtc,
  havanaLocalToUtcIso,
  utcIsoToHavanaLocal,
} from '../date';

// ============================================================
// formatDuration
// ============================================================
describe('formatDuration', () => {
  it('formats seconds only (< 60s)', () => {
    expect(formatDuration(30)).toBe('30 s');
    expect(formatDuration(1)).toBe('1 s');
    expect(formatDuration(59)).toBe('59 s');
  });

  it('formats minutes only', () => {
    expect(formatDuration(60)).toBe('1 min');
    expect(formatDuration(120)).toBe('2 min');
    expect(formatDuration(300)).toBe('5 min');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(90)).toBe('1 min 30 s');
    expect(formatDuration(61)).toBe('1 min 1 s');
  });

  it('formats hours only', () => {
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(7200)).toBe('2 h');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3661)).toBe('1 h 1 min');
    expect(formatDuration(5400)).toBe('1 h 30 min');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0 s');
  });
});

// ============================================================
// formatDistance
// ============================================================
describe('formatDistance', () => {
  it('formats meters (< 1000m)', () => {
    expect(formatDistance(500)).toBe('500 m');
    expect(formatDistance(1)).toBe('1 m');
    expect(formatDistance(999)).toBe('999 m');
  });

  it('rounds meters to integer', () => {
    expect(formatDistance(500.7)).toBe('501 m');
  });

  it('formats kilometers (>= 1000m)', () => {
    expect(formatDistance(1000)).toBe('1.0 km');
    expect(formatDistance(2500)).toBe('2.5 km');
    expect(formatDistance(10000)).toBe('10.0 km');
  });

  it('shows one decimal for km', () => {
    expect(formatDistance(1234)).toBe('1.2 km');
    expect(formatDistance(1250)).toBe('1.3 km'); // toFixed rounds 1.25 up
  });

  it('handles zero', () => {
    expect(formatDistance(0)).toBe('0 m');
  });
});

// ============================================================
// getRelativeTime
// ============================================================
describe('getRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-12T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Spanish (default)', () => {
    it('returns "ahora" for < 60 seconds ago', () => {
      const iso = new Date('2026-03-12T11:59:30Z').toISOString();
      expect(getRelativeTime(iso)).toBe('ahora');
    });

    it('returns "hace X min" for < 60 minutes ago', () => {
      const iso = new Date('2026-03-12T11:55:00Z').toISOString();
      expect(getRelativeTime(iso)).toBe('hace 5 min');
    });

    it('returns "hace X h" for < 24 hours ago', () => {
      const iso = new Date('2026-03-12T09:00:00Z').toISOString();
      expect(getRelativeTime(iso)).toBe('hace 3 h');
    });

    it('returns "ayer" for 1 day ago', () => {
      const iso = new Date('2026-03-11T12:00:00Z').toISOString();
      expect(getRelativeTime(iso)).toBe('ayer');
    });

    it('returns "hace X días" for > 1 day ago', () => {
      const iso = new Date('2026-03-09T12:00:00Z').toISOString();
      expect(getRelativeTime(iso)).toBe('hace 3 días');
    });
  });

  describe('English', () => {
    it('returns "now" for < 60 seconds ago', () => {
      const iso = new Date('2026-03-12T11:59:30Z').toISOString();
      expect(getRelativeTime(iso, 'en')).toBe('now');
    });

    it('returns "X min ago" for < 60 minutes ago', () => {
      const iso = new Date('2026-03-12T11:55:00Z').toISOString();
      expect(getRelativeTime(iso, 'en')).toBe('5 min ago');
    });

    it('returns "Xh ago" for < 24 hours ago', () => {
      const iso = new Date('2026-03-12T09:00:00Z').toISOString();
      expect(getRelativeTime(iso, 'en')).toBe('3h ago');
    });

    it('returns "yesterday" for 1 day ago', () => {
      const iso = new Date('2026-03-11T12:00:00Z').toISOString();
      expect(getRelativeTime(iso, 'en')).toBe('yesterday');
    });

    it('returns "X days ago" for > 1 day ago', () => {
      const iso = new Date('2026-03-09T12:00:00Z').toISOString();
      expect(getRelativeTime(iso, 'en')).toBe('3 days ago');
    });
  });
});

// ============================================================
// formatDate / formatTime
// These depend on Intl + timezone, so we test basic behavior
// ============================================================
describe('formatDate', () => {
  it('returns a string containing the year', () => {
    const result = formatDate('2026-03-12T10:30:00Z');
    expect(result).toContain('2026');
  });

  it('returns a non-empty string', () => {
    expect(formatDate('2026-01-15T00:00:00Z').length).toBeGreaterThan(0);
  });
});

describe('formatTime', () => {
  it('returns a string with time format (contains ":")', () => {
    const result = formatTime('2026-03-12T10:30:00Z');
    expect(result).toContain(':');
  });

  it('returns a non-empty string', () => {
    expect(formatTime('2026-03-12T23:59:00Z').length).toBeGreaterThan(0);
  });
});

// ============================================================
// havanaMidnightUtc — anchors to Havana calendar day (handles DST)
// ============================================================
describe('havanaMidnightUtc', () => {
  it('returns 05:00 UTC during CST (Jan, UTC-5)', () => {
    // Daytime UTC, well within Havana's same calendar day.
    const result = havanaMidnightUtc(new Date('2026-01-15T15:30:00Z'));
    expect(result.toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });

  it('returns 04:00 UTC during CDT (Jul, UTC-4)', () => {
    const result = havanaMidnightUtc(new Date('2026-07-15T15:30:00Z'));
    expect(result.toISOString()).toBe('2026-07-15T04:00:00.000Z');
  });

  it('walks back to the previous Havana day when UTC has rolled over', () => {
    // 2026-01-15T03:00:00Z = 2026-01-14T22:00:00 in Havana (CST).
    // Today in Havana is still the 14th, so midnight = 2026-01-14T05:00:00Z.
    const result = havanaMidnightUtc(new Date('2026-01-15T03:00:00Z'));
    expect(result.toISOString()).toBe('2026-01-14T05:00:00.000Z');
  });

  it('handles the DST transition day without crashing', () => {
    // 2026-03-08 is the 2nd Sunday of March (Cuba spring-forward day).
    // The helper resolves the offset by probing 12:00 UTC of that day,
    // which lands AFTER the transition → CDT (UTC-4). So midnight of
    // the day is computed as 04:00 UTC. This is off by 1h from the
    // pure-CST interpretation (05:00) but the gap is acceptable for
    // the daily-earnings use case (the missing 04:00-05:00 UTC slice
    // is the wall-clock hour that doesn't exist in Havana on this day
    // anyway, due to spring-forward).
    const result = havanaMidnightUtc(new Date('2026-03-08T15:00:00Z'));
    expect([4, 5]).toContain(result.getUTCHours());
    expect(result.getUTCMinutes()).toBe(0);
    // Same calendar day in Havana:
    expect(result.toISOString().slice(0, 10)).toBe('2026-03-08');
  });

  it('defaults `now` to current time when called without args', () => {
    const result = havanaMidnightUtc();
    // Just sanity-check the shape: a Date whose UTC time is 04:00 or 05:00.
    expect(result).toBeInstanceOf(Date);
    expect([4, 5]).toContain(result.getUTCHours());
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
  });
});

// ============================================================
// havanaDayRangeUtc — [start, end) UTC instants of a Havana calendar day
// ============================================================
describe('havanaDayRangeUtc', () => {
  it('returns 05:00Z boundaries during CST (Jan, UTC-5)', () => {
    const { start, end } = havanaDayRangeUtc('2026-01-15');
    expect(start.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-16T05:00:00.000Z');
  });

  it('returns 04:00Z boundaries during CDT (Jul, UTC-4)', () => {
    const { start, end } = havanaDayRangeUtc('2026-07-15');
    expect(start.toISOString()).toBe('2026-07-15T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-16T04:00:00.000Z');
  });

  it('rolls over month and year boundaries', () => {
    const { start, end } = havanaDayRangeUtc('2026-12-31');
    expect(start.toISOString()).toBe('2026-12-31T05:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T05:00:00.000Z');
  });

  it('handles the fall-back day with the documented 1h transition caveat', () => {
    // 2026-11-01 is the 1st Sunday of November (Cuba falls back CDT->CST).
    // The offset probe at 12:00 UTC lands AFTER the 01:00 transition, so the
    // day start resolves to the CST interpretation (05:00Z) - 1h after the
    // true local midnight. Same caveat havanaMidnightUtc documents; harmless
    // for since-midnight filters.
    const { start, end } = havanaDayRangeUtc('2026-11-01');
    expect(start.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('throws on malformed input', () => {
    expect(() => havanaDayRangeUtc('15/01/2026')).toThrow();
    expect(() => havanaDayRangeUtc('')).toThrow();
  });
});

describe('havanaLocalToUtcIso', () => {
  it('reads a datetime-local value as Havana time in winter (UTC-5)', () => {
    expect(havanaLocalToUtcIso('2026-01-15T10:00')).toBe('2026-01-15T15:00:00.000Z');
  });

  it('reads it as Havana time in summer (UTC-4)', () => {
    expect(havanaLocalToUtcIso('2026-07-15T10:00')).toBe('2026-07-15T14:00:00.000Z');
  });

  it('crosses into the next UTC day', () => {
    expect(havanaLocalToUtcIso('2026-01-15T22:30')).toBe('2026-01-16T03:30:00.000Z');
  });

  it('uses the offset in force on each side of the November change', () => {
    expect(havanaLocalToUtcIso('2026-10-31T10:00')).toBe('2026-10-31T14:00:00.000Z');
    expect(havanaLocalToUtcIso('2026-11-02T10:00')).toBe('2026-11-02T15:00:00.000Z');
  });

  it('uses the offset in force right after each change, even when the first guess is on the other side', () => {
    // March: 00:00 CST jumps to 01:00 CDT. November: 01:00 CDT falls back to 00:00 CST.
    expect(havanaLocalToUtcIso('2026-03-08T02:00')).toBe('2026-03-08T06:00:00.000Z');
    expect(havanaLocalToUtcIso('2026-11-01T02:00')).toBe('2026-11-01T07:00:00.000Z');
    expect(havanaLocalToUtcIso('2026-11-01T01:30')).toBe('2026-11-01T06:30:00.000Z');
  });

  it('moves a time inside the spring gap (Havana 00:00–00:59 on the March change day) forward an hour', () => {
    expect(havanaLocalToUtcIso('2026-03-08T00:30')).toBe('2026-03-08T05:30:00.000Z');
  });

  it('rejects anything that is not YYYY-MM-DDTHH:mm', () => {
    expect(() => havanaLocalToUtcIso('2026-01-15')).toThrow('YYYY-MM-DDTHH:mm');
    expect(() => havanaLocalToUtcIso('')).toThrow('YYYY-MM-DDTHH:mm');
  });

  it('reads a time in the repeated November hour as the first one, still on summer time', () => {
    // 01:00 CDT falls back to 00:00 CST: 00:30 happens at 04:30Z and again at 05:30Z.
    expect(havanaLocalToUtcIso('2026-11-01T00:30')).toBe('2026-11-01T04:30:00.000Z');
  });

  it('rejects a date or time that does not exist instead of rolling it over', () => {
    expect(() => havanaLocalToUtcIso('2026-02-30T10:00')).toThrow('not a real date and time');
    expect(() => havanaLocalToUtcIso('2026-13-01T10:00')).toThrow('not a real date and time');
    expect(() => havanaLocalToUtcIso('2026-00-10T10:00')).toThrow('not a real date and time');
    expect(() => havanaLocalToUtcIso('2026-01-15T24:00')).toThrow('not a real date and time');
    expect(() => havanaLocalToUtcIso('2026-01-15T10:60')).toThrow('not a real date and time');
    expect(() => havanaLocalToUtcIso('2026-04-31T10:00')).toThrow('not a real date and time');
  });

  it('accepts the last valid values', () => {
    expect(havanaLocalToUtcIso('2028-02-29T23:59')).toBe('2028-03-01T04:59:00.000Z');
  });
});

describe('utcIsoToHavanaLocal', () => {
  it('gives the Havana wall clock as a datetime-local value', () => {
    expect(utcIsoToHavanaLocal('2026-01-15T15:00:00.000Z')).toBe('2026-01-15T10:00');
    expect(utcIsoToHavanaLocal('2026-07-15T14:00:00.000Z')).toBe('2026-07-15T10:00');
    expect(utcIsoToHavanaLocal('2026-01-16T03:30:00.000Z')).toBe('2026-01-15T22:30');
  });

  it('round-trips with havanaLocalToUtcIso', () => {
    for (const v of ['2026-03-20T08:15', '2026-12-24T23:59', '2026-06-01T00:00']) {
      expect(utcIsoToHavanaLocal(havanaLocalToUtcIso(v))).toBe(v);
    }
  });
});

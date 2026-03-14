import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDate,
  formatTime,
  formatDuration,
  formatDistance,
  getRelativeTime,
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

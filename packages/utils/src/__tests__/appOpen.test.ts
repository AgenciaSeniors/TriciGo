import { describe, it, expect } from 'vitest';
import { shouldReportAppOpen, APP_OPEN_REPORT_INTERVAL_MS } from '../appOpen';

const HOUR = 60 * 60 * 1000;

describe('shouldReportAppOpen', () => {
  it('reports the first open of the process', () => {
    expect(shouldReportAppOpen(null, 'u-1', 1_000)).toBe(true);
  });

  it('does not report again while the last report is fresh', () => {
    const last = { userId: 'u-1', at: 0 };
    expect(shouldReportAppOpen(last, 'u-1', 5 * HOUR)).toBe(false);
  });

  it('reports again once the interval has passed (6 hours by default)', () => {
    const last = { userId: 'u-1', at: 0 };
    expect(APP_OPEN_REPORT_INTERVAL_MS).toBe(6 * HOUR);
    expect(shouldReportAppOpen(last, 'u-1', 6 * HOUR)).toBe(true);
  });

  it('reports right away when another account signs in', () => {
    const last = { userId: 'u-1', at: 0 };
    expect(shouldReportAppOpen(last, 'u-2', 1_000)).toBe(true);
  });

  it('takes a custom interval', () => {
    const last = { userId: 'u-1', at: 0 };
    expect(shouldReportAppOpen(last, 'u-1', 59_000, 60_000)).toBe(false);
    expect(shouldReportAppOpen(last, 'u-1', 60_000, 60_000)).toBe(true);
  });

  it('reports when the clock went backwards', () => {
    const last = { userId: 'u-1', at: 10 * HOUR };
    expect(shouldReportAppOpen(last, 'u-1', 1 * HOUR)).toBe(true);
  });
});

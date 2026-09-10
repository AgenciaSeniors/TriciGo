import { describe, it, expect } from 'vitest';
import {
  SEARCH_TYPICAL_WAIT_S,
  SEARCH_LONG_WAIT_S,
  searchWaitStage,
} from '../searchWait';

describe('searchWaitStage — what to tell a rider who is still waiting', () => {
  it('opens with the expectation-setting stage', () => {
    expect(searchWaitStage(0)).toBe('opening');
    expect(searchWaitStage(14)).toBe('opening');
  });

  it('says nothing extra through the stretch where most rides are accepted', () => {
    // Measured 2026-09-10 over the 29 rides with a real accepted offer:
    // p50 = 29 s, p75 = 72 s. Chatter here would be noise.
    expect(searchWaitStage(15)).toBe('normal');
    expect(searchWaitStage(44)).toBe('normal');
  });

  it('reassures through the long tail instead of declaring failure', () => {
    // The app used to replace this whole stretch with "No encontramos
    // conductor" at 120 s, while dispatch was still running and 6 of those
    // 29 rides (21 %) had not been accepted yet.
    expect(searchWaitStage(45)).toBe('extended');
    expect(searchWaitStage(119)).toBe('extended');
    expect(searchWaitStage(SEARCH_TYPICAL_WAIT_S)).toBe('extended');
    expect(searchWaitStage(179)).toBe('extended');
  });

  it('admits it is taking longer than usual past the 90th percentile', () => {
    // p90 = 145 s; only one real ride was ever accepted after 180 s.
    expect(searchWaitStage(SEARCH_LONG_WAIT_S)).toBe('long');
    expect(searchWaitStage(600)).toBe('long');
    expect(searchWaitStage(99999)).toBe('long');
  });

  it('never breaks on a nonsense clock', () => {
    // A negative or NaN elapsed must not skip the rider to the last stage.
    expect(searchWaitStage(-10)).toBe('opening');
    expect(searchWaitStage(Number.NaN)).toBe('opening');
  });

  it('keeps the long mark beyond the typical wait', () => {
    // If these ever crossed, the "taking longer" copy would appear before
    // the progress bar had even finished its normal run.
    expect(SEARCH_LONG_WAIT_S).toBeGreaterThan(SEARCH_TYPICAL_WAIT_S);
  });
});

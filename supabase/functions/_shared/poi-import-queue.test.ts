import { describe, it, expect } from 'vitest';
import { nextQueueState, MAX_DRAIN_ATTEMPTS, clampDrainSize } from './poi-import-queue';

describe('nextQueueState', () => {
  it('a fresh import is done and bumps the new POI', () => {
    expect(nextQueueState(0, { kind: 'imported', poiId: 42, reason: 'inserted' })).toEqual({
      status: 'done', attempts: 1, poi_id: 42, reason: 'inserted', bump: true,
    });
  });
  it('a dedupe hit is done and bumps the existing POI', () => {
    expect(nextQueueState(1, { kind: 'matched', poiId: 7, reason: 'duplicate_within_50m' })).toEqual({
      status: 'done', attempts: 2, poi_id: 7, reason: 'duplicate_within_50m', bump: true,
    });
  });
  it('an admin match is done without a bump (curated rows are not learned into)', () => {
    expect(nextQueueState(0, { kind: 'matched', poiId: 9, reason: 'admin_match', bump: false })).toMatchObject({ status: 'done', poi_id: 9, bump: false });
  });
  it('no match stays pending until the last attempt, then fails', () => {
    expect(nextQueueState(0, { kind: 'no_match', reason: 'no_mapbox_results' })).toEqual({
      status: 'pending', attempts: 1, poi_id: null, reason: 'no_mapbox_results', bump: false,
    });
    expect(nextQueueState(MAX_DRAIN_ATTEMPTS - 1, { kind: 'no_match', reason: 'no_good_match' })).toEqual({
      status: 'failed', attempts: MAX_DRAIN_ATTEMPTS, poi_id: null, reason: 'no_good_match', bump: false,
    });
  });
  it('an error counts as an attempt and keeps the reason', () => {
    expect(nextQueueState(0, { kind: 'error', reason: 'rpc_error: boom' })).toMatchObject({ status: 'pending', attempts: 1, reason: 'rpc_error: boom' });
  });
  it('a rejected import (out_of_cuba, name_too_short) fails immediately — retrying cannot help', () => {
    expect(nextQueueState(0, { kind: 'rejected', reason: 'out_of_cuba' })).toEqual({
      status: 'failed', attempts: 1, poi_id: null, reason: 'out_of_cuba', bump: false,
    });
  });
});

describe('clampDrainSize', () => {
  it('bounds the batch to 1..50 and defaults bad input to 20', () => {
    expect(clampDrainSize(20)).toBe(20);
    expect(clampDrainSize(0)).toBe(1);
    expect(clampDrainSize(500)).toBe(50);
    expect(clampDrainSize(Number.NaN)).toBe(20);
    expect(clampDrainSize(undefined)).toBe(20);
  });
});

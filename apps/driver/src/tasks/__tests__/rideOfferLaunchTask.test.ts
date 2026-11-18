import { describe, it, expect, beforeEach, vi } from 'vitest';

// The module defines its task and registers it at import time: capture the
// task body so the tests can run it without the native runtime.
type TaskBody = (arg: { data: unknown; error: unknown }) => Promise<void>;
const captured = vi.hoisted(() => ({ taskBody: null as ((arg: { data: unknown; error: unknown }) => Promise<void>) | null }));
vi.mock('expo-task-manager', () => ({
  defineTask: (_name: string, body: TaskBody) => {
    captured.taskBody = body;
  },
}));
const runTask = (arg: { data: unknown; error: unknown }) => captured.taskBody!(arg);
vi.mock('expo-notifications', () => ({ registerTaskAsync: vi.fn(async () => undefined) }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const attempt = vi.fn(async (..._a: unknown[]) => 'foreground');
vi.mock('@/lib/offerLaunch', () => ({ attemptOfferLaunch: (...a: unknown[]) => attempt(...a) }));

import { extractNotificationType, extractRideId } from '../rideOfferLaunchTask';

const payload = { type: 'ride_offer_launch', ride_id: 'ride-9', offer_id: 'o1' };

describe('reading the offer push', () => {
  it.each([
    ['keys at the root', payload],
    ['JSON in data.body', { data: { body: JSON.stringify(payload) } }],
    ['JSON in data.dataString', { data: { dataString: JSON.stringify(payload) } }],
    ['nested data', { data: { data: payload } }],
  ])('finds the type and the ride id with %s', (_name, raw) => {
    expect(extractNotificationType(raw)).toBe('ride_offer_launch');
    expect(extractRideId(raw)).toBe('ride-9');
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'ride_offer_launch'],
    ['non-JSON body', { data: { body: 'not json' } }],
    ['no ride id', { type: 'ride_offer_launch' }],
  ])('returns no ride id for %s', (_name, raw) => {
    expect(extractRideId(raw)).toBeUndefined();
  });
});

describe('the launch task', () => {
  beforeEach(() => {
    attempt.mockClear();
  });

  it('hands the offer to attemptOfferLaunch with its ride id', async () => {
    await runTask({ data: { data: { body: JSON.stringify(payload) } }, error: null });
    expect(attempt).toHaveBeenCalledWith('ride-9', 'push');
  });

  it('passes null when the push has no ride id', async () => {
    await runTask({ data: { type: 'ride_offer_launch' }, error: null });
    expect(attempt).toHaveBeenCalledWith(null, 'push');
  });

  it('ignores other pushes and errors', async () => {
    await runTask({ data: { type: 'ride_offer', ride_id: 'ride-9' }, error: null });
    await runTask({ data: payload, error: new Error('x') });
    expect(attempt).not.toHaveBeenCalled();
  });

  it('never throws when the attempt throws', async () => {
    attempt.mockRejectedValueOnce(new Error('boom'));
    await expect(runTask({ data: payload, error: null })).resolves.toBeUndefined();
  });
});

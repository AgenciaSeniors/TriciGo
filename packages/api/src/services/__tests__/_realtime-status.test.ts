import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the logger so we can assert it's called (and avoid __DEV__/console noise).
vi.mock('@tricigo/utils', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@tricigo/utils';
import { realtimeStatusLogger } from '../_realtime-status';

const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;

describe('realtimeStatusLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a warning on CHANNEL_ERROR, including the label and the error', () => {
    realtimeStatusLogger('ride_offers')('CHANNEL_ERROR', new Error('boom'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('ride_offers');
    expect(warn.mock.calls[0]![0]).toContain('CHANNEL_ERROR');
    expect(warn.mock.calls[0]![1]).toEqual({ error: 'Error: boom' });
  });

  it('logs a warning on TIMED_OUT', () => {
    realtimeStatusLogger('inbox')('TIMED_OUT');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('inbox');
    expect(warn.mock.calls[0]![0]).toContain('TIMED_OUT');
  });

  it('does NOT log on SUBSCRIBED (normal) or CLOSED (teardown)', () => {
    const cb = realtimeStatusLogger('chat_messages');
    cb('SUBSCRIBED');
    cb('CLOSED');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns a stable callback usable directly in .subscribe()', () => {
    const cb = realtimeStatusLogger('nearby_drivers');
    expect(typeof cb).toBe('function');
    cb('CHANNEL_ERROR');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

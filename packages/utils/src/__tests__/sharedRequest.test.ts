import { describe, expect, it, vi } from 'vitest';
import { createSharedRequests } from '../sharedRequest';

describe('createSharedRequests', () => {
  it('callers that ask for the same key at once share one request', async () => {
    let clock = 0;
    const shared = createSharedRequests(() => clock);
    const load = vi.fn().mockResolvedValue(42);

    const [a, b] = await Promise.all([shared('k', 1000, load), shared('k', 1000, load)]);

    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reuses a recent answer and asks again once it is older than the caller allows', async () => {
    let clock = 0;
    const shared = createSharedRequests(() => clock);
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    expect(await shared('k', 1000, load)).toBe('first');
    clock = 999;
    expect(await shared('k', 1000, load)).toBe('first');
    clock = 1000;
    expect(await shared('k', 1000, load)).toBe('second');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('each caller decides how old an answer it accepts', async () => {
    let clock = 0;
    const shared = createSharedRequests(() => clock);
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');

    await shared('k', 60_000, load);
    clock = 10_000;
    expect(await shared('k', 60_000, load)).toBe('first');
    expect(await shared('k', 5_000, load)).toBe('second');
  });

  it('does not keep a failed request: the next caller asks again', async () => {
    const shared = createSharedRequests(() => 0);
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');

    await expect(shared('k', 1000, load)).rejects.toThrow('boom');
    expect(await shared('k', 1000, load)).toBe('ok');
  });

  it('keeps different keys apart', async () => {
    const shared = createSharedRequests(() => 0);
    const a = vi.fn().mockResolvedValue('a');
    const b = vi.fn().mockResolvedValue('b');

    expect(await shared('a', 1000, a)).toBe('a');
    expect(await shared('b', 1000, b)).toBe('b');
  });
});

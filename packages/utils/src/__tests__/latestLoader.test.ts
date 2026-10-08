import { describe, expect, it } from 'vitest';
import { createLatestLoader } from '../latestLoader';

describe('createLatestLoader', () => {
  it('a second trigger while the same key loads is skipped and does not void the first', () => {
    // The mount sequence of a screen: focus starts the load, then the sign-in effect fires.
    const loader = createLatestLoader();
    const first = loader.begin('A');
    expect(first).not.toBeNull();
    expect(loader.begin('A')).toBeNull();
    expect(loader.settle(first!, 'A')).toBe(true);
  });

  it('once the load settles, the next trigger loads again', () => {
    const loader = createLatestLoader();
    const first = loader.begin('A')!;
    loader.settle(first, 'A');
    expect(loader.begin('A')).not.toBeNull();
  });

  it("an account switch drops the previous account's answer", () => {
    const loader = createLatestLoader();
    const a = loader.begin('A')!;
    const b = loader.begin('B')!;
    expect(loader.settle(a, 'A')).toBe(false);
    expect(loader.settle(b, 'B')).toBe(true);
  });

  it('signing out drops the answer in flight', () => {
    const loader = createLatestLoader();
    const a = loader.begin('A')!;
    expect(loader.begin(null)).toBeNull();
    expect(loader.settle(a, 'A')).toBe(false);
  });

  it('reset forces a fresh load and the older answer is dropped', () => {
    const loader = createLatestLoader();
    const stale = loader.begin('A')!;
    loader.reset();
    const fresh = loader.begin('A')!;
    expect(fresh).not.toBeNull();
    expect(loader.settle(stale, 'A')).toBe(false);
    // The fresh load is still in flight: a focus now is skipped.
    expect(loader.begin('A')).toBeNull();
    expect(loader.settle(fresh, 'A')).toBe(true);
    expect(loader.begin('A')).not.toBeNull();
  });
});

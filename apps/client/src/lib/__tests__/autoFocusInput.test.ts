import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleAutoFocus, type FocusableInput } from '../autoFocusInput';

// QA R3-03 (round 4, 2026-11-20): the add-stop search on the service screen gets the focus but
// no keyboard. logcat: `ImeTracker onFailed at PHASE_CLIENT_VIEW_SERVED`: focus() ran before
// Android connected the field to the keyboard. A second focus() does nothing (React Native
// skips focusing the input it already thinks is focused), so the retry blurs and focuses again.

function fakeInput(focused = false) {
  const state = { focused, calls: [] as string[] };
  const input: FocusableInput = {
    focus: () => { state.calls.push('focus'); state.focused = true; },
    blur: () => { state.calls.push('blur'); state.focused = false; },
    isFocused: () => state.focused,
  };
  return { input, state };
}

describe('scheduleAutoFocus', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('focuses once and stops when the keyboard shows', () => {
    const { input, state } = fakeInput();
    let keyboard = false;
    scheduleAutoFocus(() => input, () => keyboard);

    vi.advanceTimersByTime(150);
    expect(state.calls).toEqual(['focus']);
    keyboard = true;
    vi.advanceTimersByTime(2000);
    expect(state.calls).toEqual(['focus']);
  });

  it('blurs and focuses again while the field is focused but the keyboard is not shown', () => {
    const { input, state } = fakeInput();
    let keyboard = false;
    scheduleAutoFocus(() => input, () => keyboard);

    vi.advanceTimersByTime(150);
    vi.advanceTimersByTime(450);
    expect(state.calls).toEqual(['focus', 'blur', 'focus']);
    keyboard = true;
    vi.advanceTimersByTime(2000);
    expect(state.calls).toEqual(['focus', 'blur', 'focus']);
  });

  it('gives up after the last retry', () => {
    const { input, state } = fakeInput();
    scheduleAutoFocus(() => input, () => false);

    vi.advanceTimersByTime(10_000);
    expect(state.calls).toEqual(['focus', 'blur', 'focus', 'blur', 'focus']);
  });

  it('does not take the focus back when the rider moved it elsewhere', () => {
    const { input, state } = fakeInput();
    scheduleAutoFocus(() => input, () => false);

    vi.advanceTimersByTime(150);
    state.focused = false; // the rider tapped a recent place
    vi.advanceTimersByTime(5000);
    expect(state.calls).toEqual(['focus']);
  });

  it('does nothing after it is cancelled, or without an input', () => {
    const { input, state } = fakeInput();
    const cancel = scheduleAutoFocus(() => input, () => false);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(state.calls).toEqual([]);

    expect(() => {
      scheduleAutoFocus(() => null, () => false);
      vi.advanceTimersByTime(5000);
    }).not.toThrow();
  });
});

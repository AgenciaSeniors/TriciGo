/**
 * Focus a search field after it mounts and make sure the keyboard actually opens (QA R3-03).
 *
 * On Android, focus() called while the screen that holds the field is still being set up can
 * focus the field without opening the keyboard: logcat shows `ImeTracker onFailed at
 * PHASE_CLIENT_VIEW_SERVED`. Calling focus() again does nothing, because React Native skips the
 * input it already thinks is focused, so a retry blurs first. It retries only while the field
 * still has the focus: if the rider tapped something else, the focus stays where they put it.
 */
export interface FocusableInput {
  focus(): void;
  blur(): void;
  isFocused(): boolean;
}

/** First focus, then the retries (ms after mount). */
export const AUTO_FOCUS_DELAYS_MS = [150, 600, 1400] as const;

export function scheduleAutoFocus(
  getInput: () => FocusableInput | null,
  isKeyboardVisible: () => boolean,
  delays: readonly number[] = AUTO_FOCUS_DELAYS_MS,
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  const stop = () => {
    stopped = true;
    timers.forEach(clearTimeout);
  };

  delays.forEach((delay, attempt) => {
    timers.push(
      setTimeout(() => {
        if (stopped) return;
        const input = getInput();
        if (!input) return;
        if (attempt === 0) {
          input.focus();
          return;
        }
        if (isKeyboardVisible() || !input.isFocused()) {
          stop();
          return;
        }
        input.blur();
        input.focus();
      }, delay),
    );
  });

  return stop;
}

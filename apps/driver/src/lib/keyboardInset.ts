/** The part of a keyboard event the inset needs. */
export interface KeyboardEventLike {
  endCoordinates?: { height?: number; screenY?: number } | null;
}

/**
 * How far the content has to move up so the keyboard does not cover it, on a
 * screen whose bottom sits on the navigation bar (Screen's safe area).
 *
 * Android reports `height` as the keyboard minus the navigation bar
 * (ReactRootView.checkForKeyboardEvents), which is exactly that. `screenY` is
 * ignored on purpose: it comes from the window's visible frame, which
 * KeyboardAvoidingView misreads under edge-to-edge (QA R2-07).
 */
export function keyboardInset(event: KeyboardEventLike | null | undefined): number {
  const height = event?.endCoordinates?.height;
  return typeof height === 'number' && height > 0 ? Math.round(height) : 0;
}

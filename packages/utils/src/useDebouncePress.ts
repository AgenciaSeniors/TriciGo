import { useRef, useCallback } from 'react';

/**
 * Hook that prevents rapid-fire button presses.
 * Returns a wrapper function that ignores calls within the cooldown window.
 *
 * @param callback - The function to debounce
 * @param delayMs - Cooldown window in milliseconds (default: 1000ms)
 */
export function useDebouncePress(
  callback: () => void | Promise<void>,
  delayMs = 1000,
): () => void {
  const lastPressRef = useRef(0);

  return useCallback(() => {
    const now = Date.now();
    if (now - lastPressRef.current < delayMs) return;
    lastPressRef.current = now;
    callback();
  }, [callback, delayMs]);
}

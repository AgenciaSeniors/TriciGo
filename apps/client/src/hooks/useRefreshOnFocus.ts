import { useCallback, useEffect } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';

/**
 * useRefreshOnFocus — re-run `refetch` whenever the screen regains focus
 * (returning from another screen / tab) AND when the app comes back to the
 * foreground.
 *
 * Fixes the "stale-on-mount" class: on mobile, tab screens stay mounted, so a
 * once-on-mount `useEffect(fetch, [deps])` shows data frozen at app-open time
 * after an external change (admin credit, gift, ride payment, rating, status…)
 * until a full restart. The wallet screens already do this with `useFocusEffect`;
 * this hook is the canonical primitive so every mutable-data screen behaves the
 * same. See CLAUDE.md → "Auditoría de frescura de datos (stale-on-mount)".
 *
 * Pass a STABLE `refetch` (wrap it in `useCallback`) — it's used as a dependency.
 * Covers the practical cases (navigate-back, background→foreground) without the
 * cost/RLS of realtime.
 */
export function useRefreshOnFocus(refetch: () => void): void {
  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refetch();
    });
    return () => sub.remove();
  }, [refetch]);
}

import { useCallback } from 'react';
import { authService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { useChatStore } from '@/stores/chat.store';
import { useNotificationStore } from '@/stores/notification.store';

/**
 * BUG-299b — Client-side logout: sign out from Supabase and reset every
 * session-scoped zustand store.
 *
 * Returns a stable async callback safe to use inside `onPress` handlers
 * and dependency arrays. After it resolves, the RootNavigator effect in
 * `apps/client/app/_layout.tsx` (line 144-147) sees `!isAuthenticated`
 * and redirects to `/(auth)/login` automatically — no `router.replace`
 * needed at the call site.
 *
 * Resets, in order:
 *   1. Supabase auth session via `authService.signOut()`. Best-effort:
 *      network failures are swallowed because the local reset MUST still
 *      happen — otherwise the user is "logged in" to a stale session and
 *      the RootNavigator keeps them stuck in `complete-profile`.
 *   2. `useAuthStore.reset()` — clears `user`, `isAuthenticated`.
 *   3. `useRideStore.resetAll()` — clears active ride draft / history
 *      pointers so a new account doesn't inherit ride state from the
 *      previous session.
 *   4. `useChatStore.reset()` — clears in-memory chat messages.
 *   5. `useNotificationStore.reset()` — clears unread count / cached
 *      notifications.
 *
 * `useThemeStore` is intentionally NOT reset — it's a UI preference,
 * not session-bound (light/dark mode should persist across logout).
 *
 * Mirrors the driver-side hook at `apps/driver/src/hooks/useLogout.ts`
 * (BUG-299, PR #150). Kept as a separate per-app hook rather than a
 * shared package because each app has a different set of session stores.
 */
export function useLogout() {
  const resetAuth = useAuthStore((s) => s.reset);
  const resetRide = useRideStore((s) => s.resetAll);
  const resetChat = useChatStore((s) => s.reset);
  const resetNotifications = useNotificationStore((s) => s.reset);

  return useCallback(async () => {
    try {
      await authService.signOut();
    } catch {
      // best-effort: local reset below MUST happen even if network fails
    }
    resetAuth();
    resetRide();
    resetChat();
    resetNotifications();
  }, [resetAuth, resetRide, resetChat, resetNotifications]);
}

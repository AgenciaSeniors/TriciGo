import { useCallback } from 'react';
import { authService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useDriverStore } from '@/stores/driver.store';
import { useOnboardingStore } from '@/stores/onboarding.store';

/**
 * BUG-299 — Sign out + reset every auth-adjacent zustand store.
 *
 * Returns a stable async callback safe to use inside `onPress` handlers
 * and dependency arrays. After it resolves, the RootNavigator effect in
 * `apps/driver/app/_layout.tsx` (~line 196) sees `!isAuthenticated` and
 * redirects to `/(auth)/login` automatically — no `router.replace` needed
 * at the call site.
 *
 * Resets, in order:
 *   1. Supabase auth session via `authService.signOut()`. Best-effort:
 *      network failures are swallowed because the local reset MUST still
 *      happen — otherwise the user is "logged in" to a stale session and
 *      the RootNavigator keeps them inside the onboarding flow.
 *   2. `useAuthStore.reset()` — clears `user`, `isAuthenticated`.
 *   3. `useDriverStore.reset()` — clears `driverProfile`, profile-loaded flag.
 *   4. `useOnboardingStore.reset()` — clears any half-filled form data so
 *      a new account starting on the same device doesn't see ghost values
 *      (BUG-299: a driver who typed the wrong phone, scrolls to "Cerrar
 *      sesión" in personal-info, then logs back in shouldn't see their
 *      old draft).
 *
 * Used by:
 *   - `apps/driver/app/onboarding/pending.tsx` (existing escape, refactored
 *     to share this hook)
 *   - `apps/driver/src/components/onboarding/SwitchAccountFooter.tsx`
 *     (BUG-299: new escape from personal-info / vehicle-info / documents /
 *     review)
 */
export function useLogout() {
  const resetAuth = useAuthStore((s) => s.reset);
  const resetDriver = useDriverStore((s) => s.reset);
  const resetOnboarding = useOnboardingStore((s) => s.reset);

  return useCallback(async () => {
    try {
      await authService.signOut();
    } catch {
      // best-effort: local reset below MUST happen even if network fails
    }
    resetAuth();
    resetDriver();
    resetOnboarding();
  }, [resetAuth, resetDriver, resetOnboarding]);
}

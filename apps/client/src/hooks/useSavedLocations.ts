import { useEffect, useState } from 'react';
import { customerService } from '@tricigo/api';
import type { SavedLocation } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';

/**
 * The rider's saved places (Casa, Trabajo, …) from `customer_profiles`.
 *
 * Lives in its own hook so every screen with an address search can offer
 * them — the recurring-ride sheet, by definition the most repeated route
 * the rider has, used to render the search with none of this history.
 * Resolves to `[]` while loading, on sign-out, and on any error: the
 * search just shows fewer rows.
 */
export function useSavedLocations() {
  const userId = useAuthStore((s) => s.user?.id);
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);

  useEffect(() => {
    if (!userId) {
      setSavedLocations([]);
      return;
    }
    let cancelled = false;
    customerService
      .ensureProfile(userId)
      .then((cp) => {
        if (!cancelled) setSavedLocations(cp.saved_locations ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return { savedLocations };
}

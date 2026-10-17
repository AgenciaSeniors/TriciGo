import { useEffect } from 'react';
import { rideService } from '@tricigo/api';
import { signupPromoPrefill } from '@tricigo/utils';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';

/**
 * Loads the promotion of the code the user registered with (00665) when the
 * booking sheet opens, and puts its code in an empty promo field. The server
 * applies it to the ride anyway; this only shows the discount before "Pedir".
 * A code the user typed or opened from a link is never replaced.
 */
export function useSignupPromotion(): void {
  const userId = useAuthStore((s) => s.user?.id);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void rideService.getMySignupPromotion().then((promo) => {
      if (cancelled) return;
      const store = useRideStore.getState();
      store.setSignupPromo(promo);
      const code = signupPromoPrefill(store.promoCode, promo?.code ?? null);
      if (code) store.setPromoCode(code);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);
}

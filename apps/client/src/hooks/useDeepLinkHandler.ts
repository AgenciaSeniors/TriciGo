import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import Toast from 'react-native-toast-message';
import { referralService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { logger } from '@tricigo/utils';

const PENDING_REFERRAL_KEY = 'pending_referral_code';
const PENDING_PROMO_KEY = 'pending_promo_code';

/**
 * Handles deferred deep links — codes saved to AsyncStorage before
 * the user was authenticated. After login, this hook picks them up
 * and applies them automatically.
 *
 * - Referral codes: applied via referralService.applyReferralCode()
 * - Promo codes: saved to ride store for the next ride
 */
export function useDeepLinkHandler() {
  const userId = useAuthStore((s) => s.user?.id);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setPromoCode = useRideStore((s) => s.setPromoCode);
  const setDropoff = useRideStore((s) => s.setDropoff);
  const setFlowStep = useRideStore((s) => s.setFlowStep);
  const processed = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || !userId || processed.current) return;
    processed.current = true;

    async function processPendingLinks() {
      // Process pending referral code
      try {
        const pendingReferral = await AsyncStorage.getItem(PENDING_REFERRAL_KEY);
        if (pendingReferral) {
          await AsyncStorage.removeItem(PENDING_REFERRAL_KEY);
          try {
            await referralService.applyReferralCode(userId!, pendingReferral);
            Toast.show({
              type: 'success',
              text1: '¡Código de referido aplicado!',
              text2: 'Tu bono ha sido acreditado.',
            });
          } catch (err) {
            // Silently fail — user can apply manually later
            logger.warn('[DeepLink] Failed to apply referral:', err);
          }
        }
      } catch {
        // AsyncStorage read failed — non-critical
      }

      // Process pending promo code
      try {
        const pendingPromo = await AsyncStorage.getItem(PENDING_PROMO_KEY);
        if (pendingPromo) {
          await AsyncStorage.removeItem(PENDING_PROMO_KEY);
          setPromoCode(pendingPromo);
          Toast.show({
            type: 'success',
            text1: 'Código promocional guardado',
            text2: 'Se aplicará en tu próximo viaje.',
          });
        }
      } catch {
        // AsyncStorage read failed — non-critical
      }
    }

    processPendingLinks();
  }, [isAuthenticated, userId, setPromoCode]);

  // Handle tricigo://book?lat=X&lng=Y&address=Z deep links
  useEffect(() => {
    function handleBookingUrl(event: { url: string }) {
      try {
        const parsed = Linking.parse(event.url);
        if (parsed.path === 'book' && parsed.queryParams) {
          const lat = parseFloat(parsed.queryParams.lat as string);
          const lng = parseFloat(parsed.queryParams.lng as string);
          const address = (parsed.queryParams.address as string) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

          if (!isNaN(lat) && !isNaN(lng)) {
            setDropoff(address, { latitude: lat, longitude: lng });
            setFlowStep('selecting');
          }
        }
      } catch { /* silent */ }
    }

    const subscription = Linking.addEventListener('url', handleBookingUrl);

    // Handle cold start URL
    Linking.getInitialURL().then((url) => {
      if (url) handleBookingUrl({ url });
    }).catch(() => {});

    return () => subscription.remove();
  }, [setDropoff, setFlowStep]);
}

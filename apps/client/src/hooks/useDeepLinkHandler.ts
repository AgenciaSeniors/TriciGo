import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import Toast from 'react-native-toast-message';
import { referralService, getSupabaseClient } from '@tricigo/api';
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
            logger.warn('[DeepLink] Failed to apply referral:', { error: String(err) });
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

  // Handle tricigo://auth/callback — OAuth redirect from Google/Apple sign-in
  useEffect(() => {
    function handleAuthCallback(event: { url: string }) {
      try {
        const url = event.url;
        if (!url.includes('auth/callback')) return;

        // Extract tokens from URL fragment (hash)
        // Supabase OAuth redirects with: #access_token=...&refresh_token=...&...
        const hashIndex = url.indexOf('#');
        if (hashIndex === -1) return;

        const hash = url.substring(hashIndex + 1);
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');

        if (accessToken && refreshToken) {
          const supabase = getSupabaseClient();
          supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          }).then(({ error }) => {
            if (error) {
              logger.error('[DeepLink] Failed to set session from OAuth callback', { error: error.message });
              Toast.show({ type: 'error', text1: 'Error al iniciar sesión' });
            }
            // onAuthStateChange will fire SIGNED_IN and handle navigation
          });
        }
      } catch (err) {
        logger.error('[DeepLink] Error handling auth callback', { error: String(err) });
      }
    }

    const subscription = Linking.addEventListener('url', handleAuthCallback);

    // Handle cold start with auth callback URL
    Linking.getInitialURL().then((url) => {
      if (url && url.includes('auth/callback')) {
        handleAuthCallback({ url });
      }
    }).catch(() => {});

    return () => subscription.remove();
  }, []);

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

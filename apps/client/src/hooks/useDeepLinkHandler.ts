import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import Toast from 'react-native-toast-message';
import { referralService } from '@tricigo/api';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { logger } from '@tricigo/utils';
import { handleAuthLink } from '@/lib/authLink';

const PENDING_REFERRAL_KEY = 'pending_referral_code';
const PENDING_PROMO_KEY = 'pending_promo_code';

/**
 * Handles deferred deep links — codes saved to AsyncStorage before
 * the user was authenticated. After login, this hook picks them up
 * and applies them automatically.
 *
 * - Referral / invite codes: applied via referralService.applyInviteCode(),
 *   which records an influencer/channel code as the signup source or applies
 *   a friend's referral code (app/(auth)/complete-profile.tsx prefills its
 *   invite field from the same key and removes it once it used the code)
 * - Promo codes: saved to ride store for the next ride
 */
export function useDeepLinkHandler() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setPromoCode = useRideStore((s) => s.setPromoCode);
  const setDropoff = useRideStore((s) => s.setDropoff);
  const setFlowStep = useRideStore((s) => s.setFlowStep);
  const resetServiceSelection = useRideStore((s) => s.resetServiceSelection);
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
            const result = await referralService.applyInviteCode(userId!, pendingReferral);
            if (result.kind === 'source') {
              Toast.show({
                type: 'success',
                text1: t('profile.invite_code_source_applied', {
                  defaultValue: '¡Gracias! Ya sabemos cómo nos conociste.',
                }),
              });
            } else {
              Toast.show({
                type: 'success',
                text1: '¡Código de referido aplicado!',
                text2: 'Tu bono ha sido acreditado.',
              });
            }
          } catch (err) {
            // Silently fail — user can apply manually later
            logger.warn('[DeepLink] Failed to apply invite code:', { error: String(err) });
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
    // `t` only changes with the language; `processed` keeps this one-shot.
  }, [isAuthenticated, userId, setPromoCode, t]);

  // tricigo://auth/callback — Google/Apple redirect and email sign-in link.
  // handleAuthLink never lets a link replace another account's session, and
  // asks before using one this phone did not start (lib/authLink.ts).
  useEffect(() => {
    function onUrl(event: { url: string }) {
      handleAuthLink(event.url).catch((err) => {
        logger.error('[DeepLink] Error handling auth callback', { error: String(err) });
      });
    }

    const subscription = Linking.addEventListener('url', onUrl);

    // Cold start with a sign-in link.
    Linking.getInitialURL().then((url) => {
      if (url) onUrl({ url });
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
            resetServiceSelection(); // book deep link = passenger trip — never inherit a stuck mensajería mode
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
  }, [setDropoff, resetServiceSelection, setFlowStep]);
}

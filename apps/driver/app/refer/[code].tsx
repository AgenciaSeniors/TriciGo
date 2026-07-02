import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { referralService } from '@tricigo/api';
import { useAuthStore } from '@/stores/auth.store';
import { midnightEmber } from '@tricigo/theme';

// Same storage key the onboarding personal-info step reads (duplicated
// there — route files shouldn't be imported from).
const PENDING_REFERRAL_KEY = 'pending_referral_code';

/**
 * Deep link handler for referral URLs (mirror of the client app's
 * app/refer/[code].tsx — the driver app had no such route, so referral
 * links opened as 404 for driver candidates).
 * URL: tricigo-driver://refer/{code} or https://tricigo.com/refer/{code}
 *
 * If authenticated: applies the referral code immediately.
 * If not: stashes the code in AsyncStorage; the onboarding personal-info
 * step picks it up and applies it after login.
 */
export default function ReferralDeepLinkScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!code) return;

    if (!isAuthenticated) {
      // Save code for later, redirect to login
      AsyncStorage.setItem(PENDING_REFERRAL_KEY, code).then(() => {
        router.replace('/(auth)/login');
      });
      return;
    }

    // Authenticated — apply immediately
    let cancelled = false;

    async function apply() {
      try {
        await referralService.applyReferralCode(userId!, code!);
        if (!cancelled) {
          setApplied(true);
          setTimeout(() => router.replace('/(tabs)'), 2000);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : t('profile.referral_error');
          setError(msg);
        }
      }
    }

    apply();
    return () => { cancelled = true; };
  }, [code, isAuthenticated, userId]);

  if (applied) {
    return (
      <Screen bg="dark" statusBarStyle="light-content" padded>
        <View className="flex-1 items-center justify-center">
          <View className="w-20 h-20 rounded-full bg-success items-center justify-center mb-4">
            <Text variant="h1" color="inverse">✓</Text>
          </View>
          <Text variant="h3" color="inverse" className="mb-2">
            {t('profile.referral_success_title', { defaultValue: '¡Código aplicado!' })}
          </Text>
          <Text variant="body" color="secondary" className="text-center">
            {t('profile.referral_success_message', { defaultValue: 'Tu bono de referido ha sido aplicado.' })}
          </Text>
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen bg="dark" statusBarStyle="light-content" padded>
        <View className="flex-1 items-center justify-center">
          <Text variant="h3" color="inverse" className="mb-2">
            {t('error', { defaultValue: 'Error' })}
          </Text>
          <Text variant="body" color="secondary" className="mb-6 text-center">
            {error}
          </Text>
          <Button
            title={t('profile.referral_have_code', { defaultValue: 'Ingresar código manualmente' })}
            onPress={() => router.replace('/profile/referral')}
            size="lg"
          />
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="dark" statusBarStyle="light-content" padded>
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" color={midnightEmber.accent[500]} />
        <Text variant="body" color="secondary" className="mt-4">
          {t('deeplink.applying_referral', { defaultValue: 'Aplicando código de referido...' })}
        </Text>
      </View>
    </Screen>
  );
}

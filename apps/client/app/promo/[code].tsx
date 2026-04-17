import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { useAuthStore } from '@/stores/auth.store';
import { useRideStore } from '@/stores/ride.store';
import { colors } from '@tricigo/theme';

const PENDING_PROMO_KEY = 'pending_promo_code';

/**
 * Deep link handler for promo code URLs.
 * URL: tricigo://promo/{code} or https://tricigo.com/promo/{code}
 *
 * If authenticated: saves promo code to ride store and navigates to home.
 * If not authenticated: saves code to AsyncStorage for later application after login.
 */
export default function PromoDeepLinkScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { t } = useTranslation('common');
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setPromoCode = useRideStore((s) => s.setPromoCode);

  useEffect(() => {
    if (!code) return;

    if (!isAuthenticated) {
      // Save code for later, redirect to login
      AsyncStorage.setItem(PENDING_PROMO_KEY, code).then(() => {
        router.replace('/(auth)/login');
      });
      return;
    }

    // Authenticated — save promo and navigate to home
    setPromoCode(code);
    router.replace('/(tabs)');
  }, [code, isAuthenticated]);

  return (
    <Screen bg="white" padded>
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" color={colors.brand.orange} />
        <Text variant="body" color="secondary" className="mt-4">
          {t('deeplink.loading', { defaultValue: 'Cargando...' })}
        </Text>
      </View>
    </Screen>
  );
}

import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api';
import { colors } from '@tricigo/theme';

/**
 * Deep link handler for shared ride URLs.
 * URL: tricigo://ride/share/{token} or https://tricigo.app/ride/share/{token}
 *
 * Looks up the ride by share_token and redirects to the ride detail screen.
 */
export default function RideShareTokenScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { t } = useTranslation('rider');
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!token) {
      setError(true);
      return;
    }

    let cancelled = false;

    async function resolve() {
      try {
        const ride = await rideService.getRideByShareToken(token!);
        if (cancelled) return;
        if (ride) {
          // Replace so back button doesn't return to this loading screen
          router.replace(`/ride/${ride.id}`);
        } else {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    }

    resolve();
    return () => { cancelled = true; };
  }, [token]);

  if (error) {
    return (
      <Screen bg="white" padded>
        <View className="flex-1 items-center justify-center">
          <Text variant="h3" className="mb-2">
            {t('deeplink.ride_not_found', { defaultValue: 'Viaje no encontrado' })}
          </Text>
          <Text variant="body" color="secondary" className="mb-6 text-center">
            {t('deeplink.ride_not_found_desc', { defaultValue: 'El enlace del viaje no es válido o ha expirado.' })}
          </Text>
          <Button
            title={t('common.go_home', { defaultValue: 'Ir al inicio' })}
            onPress={() => router.replace('/(tabs)')}
            size="lg"
          />
        </View>
      </Screen>
    );
  }

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

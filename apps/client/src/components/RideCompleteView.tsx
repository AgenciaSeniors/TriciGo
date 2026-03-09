import React from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useRideStore } from '@/stores/ride.store';

export function RideCompleteView() {
  const { t } = useTranslation('rider');
  const activeRide = useRideStore((s) => s.activeRide);
  const resetAll = useRideStore((s) => s.resetAll);

  if (!activeRide) return null;

  const fare = activeRide.final_fare_cup ?? activeRide.estimated_fare_cup;

  return (
    <View className="flex-1 pt-8 items-center">
      {/* Success icon */}
      <View className="w-20 h-20 rounded-full bg-success items-center justify-center mb-4">
        <Text variant="h1" color="inverse">✓</Text>
      </View>

      <Text variant="h3" className="mb-2">
        {t('ride.completed')}
      </Text>

      {/* Fare */}
      <Text variant="h2" color="accent" className="mb-6">
        {formatCUP(fare)}
      </Text>

      {/* Route summary */}
      <Card variant="outlined" padding="md" className="w-full mb-6">
        <View className="flex-row items-start mb-3">
          <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="secondary">{t('ride.pickup')}</Text>
            <Text variant="bodySmall">{activeRide.pickup_address}</Text>
          </View>
        </View>
        <View className="flex-row items-start">
          <View className="w-3 h-3 rounded-full bg-neutral-800 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="secondary">{t('ride.dropoff')}</Text>
            <Text variant="bodySmall">{activeRide.dropoff_address}</Text>
          </View>
        </View>
      </Card>

      {/* Rating placeholder */}
      <View className="flex-row gap-2 mb-6">
        {[1, 2, 3, 4, 5].map((star) => (
          <Text key={star} variant="h3" color="tertiary">★</Text>
        ))}
      </View>
      <Text variant="caption" color="tertiary" className="mb-6">
        {t('ride.rate_driver')}
      </Text>

      {/* Done button */}
      <Button
        title={t('ride.done', { defaultValue: 'Listo' })}
        size="lg"
        fullWidth
        onPress={resetAll}
      />
    </View>
  );
}

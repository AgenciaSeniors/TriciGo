import React from 'react';
import { View } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Ride } from '@tricigo/types';

interface IncomingRideCardProps {
  ride: Ride;
  onAccept: (rideId: string) => void;
}

export function IncomingRideCard({ ride, onAccept }: IncomingRideCardProps) {
  const { t } = useTranslation('driver');

  return (
    <Card variant="filled" padding="md" className="bg-neutral-800 mb-3">
      {/* Pickup */}
      <View className="flex-row items-start mb-2">
        <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
        <View className="flex-1">
          <Text variant="caption" color="inverse" className="opacity-50">
            {t('trip.pickup_address')}
          </Text>
          <Text variant="bodySmall" color="inverse">
            {ride.pickup_address}
          </Text>
        </View>
      </View>

      {/* Dropoff */}
      <View className="flex-row items-start mb-3">
        <View className="w-3 h-3 rounded-full bg-neutral-400 mt-1 mr-3" />
        <View className="flex-1">
          <Text variant="caption" color="inverse" className="opacity-50">
            {t('trip.dropoff_address')}
          </Text>
          <Text variant="bodySmall" color="inverse">
            {ride.dropoff_address}
          </Text>
        </View>
      </View>

      {/* Info row */}
      <View className="flex-row items-center justify-between mb-3">
        <Text variant="h4" color="accent">
          {formatCUP(ride.estimated_fare_cup)}
        </Text>
        <View className="flex-row gap-2">
          <View className="bg-neutral-700 px-2 py-1 rounded">
            <Text variant="caption" color="inverse">
              {ride.service_type === 'triciclo_basico' ? '🛺' : ride.service_type === 'moto_standard' ? '🏍️' : '🚗'}
            </Text>
          </View>
          <View className="bg-neutral-700 px-2 py-1 rounded">
            <Text variant="caption" color="inverse">
              {ride.payment_method === 'cash' ? 'Efectivo' : 'TC'}
            </Text>
          </View>
        </View>
      </View>

      {/* Accept button */}
      <Button
        title={t('home.accept')}
        size="lg"
        fullWidth
        onPress={() => onAccept(ride.id)}
      />
    </Card>
  );
}

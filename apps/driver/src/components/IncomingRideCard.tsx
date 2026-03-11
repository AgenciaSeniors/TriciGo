import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { formatCUP, formatTRC, cupToTrcCentavos } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import type { Ride } from '@tricigo/types';

interface ServiceConfig {
  base_fare_cup: number;
  per_km_rate_cup: number;
  per_minute_rate_cup: number;
  min_fare_cup: number;
}

interface IncomingRideCardProps {
  ride: Ride;
  onAccept: (rideId: string) => void;
  driverCustomRateCup: number | null;
  serviceConfig: ServiceConfig | null;
}

export function IncomingRideCard({ ride, onAccept, driverCustomRateCup, serviceConfig }: IncomingRideCardProps) {
  const { t } = useTranslation('driver');

  // Calculate fare using the driver's own rate
  const driverFare = useMemo(() => {
    if (!serviceConfig) {
      // Fallback: use the platform estimate from the ride
      return { cup: ride.estimated_fare_cup, trc: ride.estimated_fare_trc };
    }

    const effectiveRate = driverCustomRateCup ?? serviceConfig.per_km_rate_cup;
    const distKm = ride.estimated_distance_m / 1000;
    const durMin = ride.estimated_duration_s / 60;

    const rawFare = Math.round(
      serviceConfig.base_fare_cup +
      distKm * effectiveRate +
      durMin * serviceConfig.per_minute_rate_cup,
    );
    const baseFare = Math.max(rawFare, serviceConfig.min_fare_cup);
    const surgedFare = Math.round(baseFare * (ride.surge_multiplier ?? 1));

    // Apply discount
    const discount = ride.discount_amount_cup ?? 0;
    const fareCup = Math.max(surgedFare - discount, 0);

    // Convert to TRC if exchange rate available
    const fareTrc = ride.exchange_rate_usd_cup
      ? cupToTrcCentavos(fareCup, ride.exchange_rate_usd_cup)
      : null;

    return { cup: fareCup, trc: fareTrc };
  }, [ride, driverCustomRateCup, serviceConfig]);

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
        <View>
          <Text variant="h4" color="accent">
            {formatCUP(driverFare.cup)}
          </Text>
          {driverFare.trc != null && (
            <Text variant="caption" color="inverse" className="opacity-50">
              ~{formatTRC(driverFare.trc)}
            </Text>
          )}
        </View>
        <View className="flex-row gap-2">
          <View className="bg-neutral-700 px-2 py-1 rounded">
            <Ionicons
              name={ride.service_type === 'triciclo_basico' ? 'bicycle-outline' : ride.service_type === 'moto_standard' ? 'flash-outline' : 'car-outline'}
              size={16}
              color="white"
            />
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

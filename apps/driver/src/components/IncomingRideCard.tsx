import React, { useMemo, useRef, useCallback } from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { Avatar } from '@tricigo/ui/Avatar';
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
  /** Rider display name */
  riderName?: string;
  /** Rider avatar URL */
  riderAvatarUrl?: string | null;
  /** Rider average rating (1-5) */
  riderRating?: number | null;
}

export function IncomingRideCard({ ride, onAccept, driverCustomRateCup, serviceConfig, riderName, riderAvatarUrl, riderRating }: IncomingRideCardProps) {
  const { t } = useTranslation('driver');
  const lastAcceptPressRef = useRef(0);
  const debouncedAccept = useCallback(() => {
    const now = Date.now();
    if (now - lastAcceptPressRef.current < 1000) return;
    lastAcceptPressRef.current = now;
    onAccept(ride.id);
  }, [onAccept, ride.id]);

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
      {/* Rider info */}
      {riderName && (
        <View className="flex-row items-center mb-3 pb-3 border-b border-neutral-700" accessible={true} accessibilityLabel={`${riderName}${riderRating != null ? `, ${riderRating.toFixed(1)} ${t('common.stars', { defaultValue: 'stars' })}` : ''}`}>
          <Avatar uri={riderAvatarUrl} size={36} name={riderName} />
          <View className="ml-3 flex-1">
            <Text variant="body" color="inverse" className="font-semibold">
              {riderName}
            </Text>
            {riderRating != null && (
              <Text variant="caption" color="inverse" className="opacity-60">
                ★ {riderRating.toFixed(1)}
              </Text>
            )}
          </View>
        </View>
      )}

      {/* Rider preferences */}
      {ride.rider_preferences && Object.values(ride.rider_preferences).some(Boolean) && (
        <View className="flex-row flex-wrap gap-1.5 mb-3 pb-3 border-b border-neutral-700">
          {ride.rider_preferences.quiet_mode && (
            <View className="flex-row items-center bg-neutral-700 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="volume-mute" size={12} color="#FFA726" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_quiet', { defaultValue: 'Silencio' })}</Text>
            </View>
          )}
          {ride.rider_preferences.temperature === 'cool' && (
            <View className="flex-row items-center bg-neutral-700 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="snow" size={12} color="#42A5F5" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_cool', { defaultValue: 'AC fresco' })}</Text>
            </View>
          )}
          {ride.rider_preferences.temperature === 'warm' && (
            <View className="flex-row items-center bg-neutral-700 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="sunny" size={12} color="#FFA726" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_warm', { defaultValue: 'Cálido' })}</Text>
            </View>
          )}
          {ride.rider_preferences.conversation_ok && (
            <View className="flex-row items-center bg-neutral-700 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="chatbubbles" size={12} color="#66BB6A" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_conversation', { defaultValue: 'Conversación' })}</Text>
            </View>
          )}
          {ride.rider_preferences.luggage_trunk && (
            <View className="flex-row items-center bg-neutral-700 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="briefcase" size={12} color="#AB47BC" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_trunk', { defaultValue: 'Maletero' })}</Text>
            </View>
          )}
        </View>
      )}

      {/* Pickup */}
      <View className="flex-row items-start mb-2" accessible={true} accessibilityLabel={t('a11y.pickup_address', { ns: 'common', address: ride.pickup_address })}>
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
      <View className="flex-row items-start mb-3" accessible={true} accessibilityLabel={t('a11y.dropoff_address', { ns: 'common', address: ride.dropoff_address })}>
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
      <View className="flex-row items-center justify-between mb-3" accessible={true} accessibilityLabel={`${t('a11y.fare_amount', { ns: 'common', amount: formatCUP(driverFare.cup) })}, ${ride.payment_method === 'cash' ? t('common.cash') : t('trip.tricicoin')}`}>
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
              accessibilityLabel={ride.service_type === 'triciclo_basico' ? t('onboarding.triciclo', { defaultValue: 'Triciclo' }) : ride.service_type === 'moto_standard' ? t('onboarding.moto', { defaultValue: 'Moto' }) : t('onboarding.auto', { defaultValue: 'Auto' })}
            />
          </View>
          <View className="bg-neutral-700 px-2 py-1 rounded">
            <Text variant="caption" color="inverse">
              {ride.payment_method === 'cash' ? t('common.cash') : t('trip.tricicoin')}
            </Text>
          </View>
        </View>
      </View>

      {/* Accept button */}
      <Button
        title={t('home.accept')}
        size="lg"
        fullWidth
        onPress={debouncedAccept}
      />
    </Card>
  );
}

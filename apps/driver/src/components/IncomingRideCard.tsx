import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import { View, Animated } from 'react-native';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { formatCUP, formatTRC, cupToTrcCentavos, haversineDistance } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useLocationStore } from '@/stores/location.store';
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
  onReject?: (rideId: string) => void;
  driverCustomRateCup: number | null;
  serviceConfig: ServiceConfig | null;
  /** Rider display name */
  riderName?: string;
  /** Rider avatar URL */
  riderAvatarUrl?: string | null;
  /** Rider average rating (1-5) */
  riderRating?: number | null;
}

function IncomingRideCardInner({ ride, onAccept, onReject, driverCustomRateCup, serviceConfig }: IncomingRideCardProps) {
  const { t } = useTranslation('driver');
  const acceptingRef = useRef(false);
  const debouncedAccept = useCallback(() => {
    if (acceptingRef.current) return;
    acceptingRef.current = true;
    onAccept(ride.id);
    // Reset after 3s in case accept fails silently
    setTimeout(() => { acceptingRef.current = false; }, 3000);
  }, [onAccept, ride.id]);

  const handleReject = useCallback(() => {
    onReject?.(ride.id);
  }, [onReject, ride.id]);

  // ── Countdown timer (30s) ──
  const [secondsLeft, setSecondsLeft] = useState(30);
  const progressAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          onReject?.(ride.id); // Auto-reject when time runs out
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    Animated.timing(progressAnim, {
      toValue: 0,
      duration: 30000,
      useNativeDriver: false,
    }).start();

    return () => clearInterval(interval);
  }, []);

  // ── Distance + ETA to pickup ──
  const driverLat = useLocationStore((s) => s.latitude);
  const driverLng = useLocationStore((s) => s.longitude);

  const distanceKm = useMemo(() => {
    if (!driverLat || !driverLng || !ride.pickup_location?.latitude || !ride.pickup_location?.longitude) return null;
    const meters = haversineDistance(
      { latitude: driverLat, longitude: driverLng },
      ride.pickup_location,
    );
    return Math.round(meters / 100) / 10;
  }, [driverLat, driverLng, ride.pickup_location]);

  const etaMinutes = useMemo(() => {
    if (!distanceKm) return null;
    return Math.ceil(distanceKm / 0.33); // ~20 km/h average urban speed
  }, [distanceKm]);

  // ── Net earnings (fare minus 15% commission) ──
  const driverFare = useMemo(() => {
    if (!serviceConfig) {
      return { cup: ride.estimated_fare_cup, trc: ride.estimated_fare_trc };
    }

    const effectiveRate = driverCustomRateCup ?? serviceConfig.per_km_rate_cup;
    const distKm = (ride.estimated_distance_m ?? 0) / 1000;
    const durMin = (ride.estimated_duration_s ?? 0) / 60;

    const rawFare = Math.round(
      serviceConfig.base_fare_cup +
      distKm * effectiveRate +
      durMin * serviceConfig.per_minute_rate_cup,
    );
    const baseFare = Math.max(rawFare, serviceConfig.min_fare_cup);
    const surgedFare = Math.round(baseFare * (ride.surge_multiplier ?? 1));

    const discount = ride.discount_amount_cup ?? 0;
    const fareCup = Math.max(surgedFare - discount, 0);

    const fareTrc = ride.exchange_rate_usd_cup
      ? cupToTrcCentavos(fareCup, ride.exchange_rate_usd_cup)
      : null;

    return { cup: fareCup, trc: fareTrc };
  }, [ride, driverCustomRateCup, serviceConfig]);

  const netEarnings = useMemo(() => {
    const fare = driverFare.cup || 0;
    return Math.round(fare * 0.85);
  }, [driverFare.cup]);

  const profitLevel = useMemo(() => {
    if (!distanceKm || distanceKm <= 0) return 'good';
    const perKm = netEarnings / distanceKm;
    if (perKm >= 80) return 'great';
    if (perKm >= 40) return 'good';
    return 'short';
  }, [netEarnings, distanceKm]);

  const cardBorderStyle = profitLevel === 'great'
    ? { borderColor: '#22C55E', borderWidth: 2 }
    : profitLevel === 'short'
      ? { borderColor: '#F59E0B', borderWidth: 2 }
      : {};

  return (
    <AnimatedCard delay={0} duration={300}>
    <Card variant="filled" padding="md" className="bg-neutral-800 mb-3" style={cardBorderStyle}>
      {/* Countdown bar */}
      <View style={{ height: 4, backgroundColor: '#374151', borderRadius: 2, marginBottom: 8 }}>
        <Animated.View style={{
          height: 4,
          borderRadius: 2,
          backgroundColor: secondsLeft <= 10 ? '#EF4444' : '#F97316',
          width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        }} />
      </View>
      <Text style={{ textAlign: 'right', fontSize: 12, color: secondsLeft <= 10 ? '#EF4444' : '#9CA3AF', marginBottom: 4 }}>
        {secondsLeft}s
      </Text>

      {/* Distance + ETA to pickup */}
      {distanceKm !== null && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
          <Ionicons name="navigate-outline" size={14} color="#9CA3AF" />
          <Text style={{ fontSize: 13, color: '#9CA3AF', marginLeft: 4 }}>
            {distanceKm} km · ~{etaMinutes} min
          </Text>
        </View>
      )}

      {/* Net earnings — most prominent */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
        {profitLevel === 'great' && (
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#22C55E', marginRight: 6 }} />
        )}
        {profitLevel === 'short' && (
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#F59E0B', marginRight: 6 }} />
        )}
        <Text style={{ fontSize: 22, fontWeight: '800', color: '#22C55E' }}>
          {t('home.net_earnings', { amount: `₧${netEarnings.toLocaleString()}` })}
        </Text>
      </View>

      {/* Fare (secondary) */}
      <View className="mb-3" accessible={true} accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: formatCUP(driverFare.cup) })}>
        <Text variant="bodySmall" color="inverse" className="opacity-60">
          {t('trip.total_fare')}: {formatCUP(driverFare.cup)}
          {driverFare.trc != null ? ` (~${formatTRC(driverFare.trc)})` : ''}
        </Text>
      </View>

      {/* Pickup */}
      <View className="flex-row items-start mb-2" accessible={true} accessibilityLabel={t('a11y.pickup_address', { ns: 'common', address: ride.pickup_address })}>
        <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
        <Text variant="bodySmall" color="inverse" className="flex-1" numberOfLines={1}>
          {ride.pickup_address}
        </Text>
      </View>

      {/* Dropoff */}
      <View className="flex-row items-start mb-3" accessible={true} accessibilityLabel={t('a11y.dropoff_address', { ns: 'common', address: ride.dropoff_address })}>
        <View className="w-3 h-3 rounded-full bg-neutral-400 mt-1 mr-3" />
        <Text variant="bodySmall" color="inverse" className="flex-1" numberOfLines={1}>
          {ride.dropoff_address}
        </Text>
      </View>

      {/* Service type + payment badges */}
      <View className="flex-row items-center gap-2 mb-3">
        <View className="bg-neutral-700 px-2 py-1 rounded">
          <Ionicons
            name={ride.service_type === 'triciclo_basico' || ride.service_type === 'triciclo_cargo' ? 'bicycle-outline' : ride.service_type === 'moto_standard' ? 'flash-outline' : 'car-outline'}
            size={16}
            color="white"
            accessibilityLabel={ride.service_type === 'triciclo_basico' ? t('onboarding.triciclo', { defaultValue: 'Triciclo' }) : ride.service_type === 'triciclo_cargo' ? 'Cargo' : ride.service_type === 'moto_standard' ? t('onboarding.moto', { defaultValue: 'Moto' }) : t('onboarding.auto', { defaultValue: 'Auto' })}
          />
        </View>
        {ride.service_type === 'triciclo_cargo' && (
          <View className="bg-orange-600 px-2 py-1 rounded">
            <Text variant="caption" color="inverse" className="font-bold">CARGO</Text>
          </View>
        )}
        <View className="bg-neutral-700 px-2 py-1 rounded">
          <Text variant="caption" color="inverse">
            {ride.payment_method === 'cash' ? t('common.cash') : t('trip.tricicoin')}
          </Text>
        </View>
      </View>

      {/* Accept (75%) + Reject (25%) buttons */}
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            title={t('home.reject', { defaultValue: 'Rechazar' })}
            size="lg"
            fullWidth
            variant="outline"
            onPress={handleReject}
          />
        </View>
        <View className="flex-[3]">
          <Button
            title={t('home.accept')}
            size="lg"
            fullWidth
            onPress={debouncedAccept}
          />
        </View>
      </View>
    </Card>
    </AnimatedCard>
  );
}

export const IncomingRideCard = React.memo(IncomingRideCardInner);

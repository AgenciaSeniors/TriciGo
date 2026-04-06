import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import { View, Animated, Pressable, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { formatCUP, formatTRC, cupToTrcCentavos, haversineDistance, trackValidationEvent, jitterLocation } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { presenceService } from '@tricigo/api';
import { colors } from '@tricigo/theme';
import { useLocationStore } from '@/stores/location.store';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import type { Ride, SearchingDriverPresence } from '@tricigo/types';

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
  riderName?: string;
  riderAvatarUrl?: string | null;
  riderRating?: number | null;
}

// Profit level colors from theme tokens
const PROFIT_COLORS = {
  great: colors.profit.high,
  good: colors.status.online,
  short: colors.profit.medium,
} as const;

const PROFIT_ICONS = {
  great: 'trending-up' as const,
  good: 'checkmark-circle' as const,
  short: 'alert-circle' as const,
} as const;

function IncomingRideCardInner({ ride, onAccept, onReject, driverCustomRateCup, serviceConfig }: IncomingRideCardProps) {
  const { t } = useTranslation('driver');

  // ── Distance + ETA to pickup ──
  const driverLat = useLocationStore((s) => s.latitude);
  const driverLng = useLocationStore((s) => s.longitude);

  // ── Presence: announce this driver is reviewing the offer ──
  const driverProfile = useDriverStore((s) => s.profile);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!driverLat || !driverLng || !driverProfile || !user) return;

    const jittered = jitterLocation(driverLat, driverLng, 200);
    const presence: SearchingDriverPresence = {
      driverId: driverProfile.id,
      name: user.full_name,
      avatarUrl: user.avatar_url,
      vehicleType: ride.service_type,
      rating: driverProfile.rating_avg,
      location: jittered,
      joinedAt: Date.now(),
    };

    presenceService.joinRideSearch(ride.id, presence);

    return () => {
      presenceService.leaveRideSearch(ride.id);
    };
  }, [ride.id, driverLat, driverLng, driverProfile?.id, user?.full_name]); // eslint-disable-line react-hooks/exhaustive-deps

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
    return Math.ceil(distanceKm / 0.33);
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

  // ── Auto-accept countdown ──
  const autoAcceptDuration = profitLevel === 'great' ? 2 : profitLevel === 'good' ? 5 : 8;
  const countdownProgress = useRef(new Animated.Value(1)).current;
  const [autoAcceptSecondsLeft, setAutoAcceptSecondsLeft] = useState(autoAcceptDuration);

  const handleReject = useCallback(() => {
    trackValidationEvent('driver_ride_rejected', {
      profit_level: profitLevel,
      seconds_remaining: autoAcceptSecondsLeft,
      distance_km: distanceKm,
      net_earnings: netEarnings,
    }, ride.id);
    onReject?.(ride.id);
  }, [onReject, ride.id, profitLevel, autoAcceptSecondsLeft, distanceKm, netEarnings]);

  useEffect(() => {
    Animated.timing(countdownProgress, {
      toValue: 0,
      duration: autoAcceptDuration * 1000,
      useNativeDriver: false,
    }).start();

    const interval = setInterval(() => {
      setAutoAcceptSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          trackValidationEvent('driver_ride_auto_accepted', {
            profit_level: profitLevel,
            countdown_duration: autoAcceptDuration,
            distance_km: distanceKm,
            net_earnings: netEarnings,
          }, ride.id);
          Toast.show({ type: 'success', text1: t('home.ride_accepted', { defaultValue: '¡Viaje aceptado!' }), visibilityTime: 1500 });
          onAccept(ride.id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAcceptDuration, onAccept]);

  const profitColor = PROFIT_COLORS[profitLevel];
  const profitIcon = PROFIT_ICONS[profitLevel];

  const profitLabel = profitLevel === 'great'
    ? t('home.profitable_ride', { defaultValue: 'Viaje rentable' })
    : profitLevel === 'short'
      ? t('home.short_ride_reject', { defaultValue: 'Viaje corto' })
      : t('home.available_ride', { defaultValue: 'Viaje disponible' });

  return (
    <AnimatedCard delay={0} duration={300}>
    <Card
      forceDark
      variant="surface"
      padding="md"
      className="mb-3"
      style={profitLevel === 'great' ? { borderColor: colors.profit.high, borderWidth: 2 } : profitLevel === 'short' ? { borderColor: colors.profit.medium, borderWidth: 1.5 } : {}}
    >
      {/* ── Top: Distance + ETA + Profit indicator ── */}
      <View className="flex-row items-center justify-between mb-3">
        {distanceKm !== null && (
          <View className="flex-row items-center">
            <Ionicons name="navigate-outline" size={14} color={colors.neutral[400]} />
            <Text variant="caption" color="secondary" className="ml-1">
              {distanceKm} km · ~{etaMinutes} min
            </Text>
          </View>
        )}
        {/* Accessible profit badge: icon + text + color */}
        <StatusBadge
          label={profitLabel}
          icon={profitIcon}
          variant={profitLevel === 'great' ? 'success' : profitLevel === 'short' ? 'warning' : 'info'}
        />
      </View>

      {/* ── Net earnings — hero value ── */}
      <View className="flex-row items-baseline mb-1">
        <Text variant="stat" style={{ color: profitColor }}>
          ₧{netEarnings.toLocaleString()}
        </Text>
      </View>

      {/* Fare (secondary) */}
      <View className="mb-4" accessible accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: formatCUP(driverFare.cup) })}>
        <Text variant="caption" color="secondary">
          {t('trip.total_fare')}: {formatCUP(driverFare.cup)}
          {driverFare.trc != null ? ` (~${formatTRC(driverFare.trc)})` : ''}
        </Text>
      </View>

      {/* ── Route: Pickup → Dropoff ── */}
      <View className="mb-4">
        <View className="flex-row items-start mb-2.5" accessible accessibilityLabel={t('a11y.pickup_address', { ns: 'common', address: ride.pickup_address })}>
          <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
          <Text variant="bodySmall" color="inverse" className="flex-1 font-medium" numberOfLines={1}>
            {ride.pickup_address}
          </Text>
        </View>

        {/* Connecting line */}
        <View className="ml-[5px] w-px h-3 bg-white/12 mb-0.5" />

        <View className="flex-row items-start" accessible accessibilityLabel={t('a11y.dropoff_address', { ns: 'common', address: ride.dropoff_address })}>
          <View className="w-3 h-3 rounded-full bg-neutral-500 mt-1 mr-3" />
          <Text variant="bodySmall" color="inverse" className="flex-1" numberOfLines={1}>
            {ride.dropoff_address}
          </Text>
        </View>
      </View>

      {/* ── Info badges ── */}
      <View className="flex-row flex-wrap items-center gap-2 mb-4">
        <View className="bg-[#252540] px-2.5 py-1.5 rounded-lg flex-row items-center">
          <Ionicons
            name={ride.service_type === 'triciclo_basico' || ride.service_type === 'triciclo_cargo' ? 'bicycle-outline' : ride.service_type === 'moto_standard' ? 'flash-outline' : 'car-outline'}
            size={14}
            color={colors.neutral[300]}
          />
        </View>

        {(ride.service_type === 'triciclo_cargo' || ride.ride_mode === 'cargo') && (
          <View className="bg-primary-500/20 px-2.5 py-1.5 rounded-lg flex-row items-center">
            <Ionicons name="cube" size={12} color={colors.brand.orange} />
            <Text variant="badge" color="accent" className="ml-1">CARGO</Text>
          </View>
        )}

        <View className="bg-[#252540] px-2.5 py-1.5 rounded-lg">
          <Text variant="badge" color="inverse">
            {ride.payment_method === 'cash' ? t('common.cash')
              : ride.payment_method === 'tropipay' ? 'TropiPay'
              : ride.payment_method === 'corporate' ? t('home.payment_corporate', { defaultValue: 'Corporativo' })
              : ride.payment_method === 'mixed' ? t('home.payment_mixed', { defaultValue: 'Mixto' })
              : t('trip.tricicoin')}
          </Text>
        </View>

        {ride.waypoints && ride.waypoints.length > 0 && (
          <View className="bg-purple-500/20 px-2.5 py-1.5 rounded-lg flex-row items-center gap-1">
            <Ionicons name="flag-outline" size={12} color="#A78BFA" />
            <Text variant="badge" style={{ color: '#A78BFA' }}>
              {t('home.waypoints_badge', { count: ride.waypoints.length, defaultValue: '{{count}} paradas' })}
            </Text>
          </View>
        )}

        {ride.corporate_account_id && (
          <View className="bg-blue-500/20 px-2.5 py-1.5 rounded-lg flex-row items-center gap-1">
            <Ionicons name="business-outline" size={12} color="#60A5FA" />
            <Text variant="badge" style={{ color: '#60A5FA' }}>
              {t('home.corporate_ride', { defaultValue: 'Corporativo' })}
            </Text>
          </View>
        )}
      </View>

      {/* Scheduled ride banner */}
      {ride.scheduled_at && (
        <View className="flex-row items-center bg-blue-500/10 rounded-xl py-2 px-3 mb-4 border border-blue-500/20">
          <Ionicons name="time-outline" size={14} color="#60A5FA" />
          <Text variant="caption" style={{ color: '#60A5FA' }} className="ml-2">
            {t('home.scheduled_at', { time: new Date(ride.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), defaultValue: 'Programado: {{time}}' })}
          </Text>
        </View>
      )}

      {/* ── Auto-accept countdown ── */}
      <View className="mb-3">
        <View className="flex-row items-center justify-between mb-1.5">
          <Text variant="caption" color="secondary">
            {t('home.auto_accepting_in', { seconds: autoAcceptSecondsLeft })}
          </Text>
          <Text variant="badge" style={{ color: profitColor }}>
            {autoAcceptSecondsLeft}s
          </Text>
        </View>
        <View style={{ height: 4, backgroundColor: '#252540', borderRadius: 2 }}>
          <Animated.View style={{
            height: 4,
            backgroundColor: profitColor,
            borderRadius: 2,
            width: countdownProgress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          }} />
        </View>
      </View>

      {/* ── Reject button (min 48px height) ── */}
      <Pressable
        style={{
          backgroundColor: colors.error.DEFAULT,
          borderRadius: 16,
          paddingVertical: 14,
          alignItems: 'center',
          minHeight: 48,
          justifyContent: 'center',
        }}
        onPress={handleReject}
        accessibilityRole="button"
        accessibilityLabel={t('home.reject', { defaultValue: 'Rechazar viaje' })}
        accessibilityHint={t('home.reject_hint', { defaultValue: 'Rechaza este viaje y espera el siguiente' })}
      >
        <Text variant="body" color="inverse">
          {t('home.reject', { defaultValue: 'Rechazar' })}
        </Text>
      </Pressable>
    </Card>
    </AnimatedCard>
  );
}

export const IncomingRideCard = React.memo(IncomingRideCardInner);

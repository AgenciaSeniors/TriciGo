import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import { View, Animated, Pressable, Text as RNText, Easing } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { formatCUP, formatTRC, cupToTrcCentavos, haversineDistance, jitterLocation, triggerHaptic } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { presenceService, trackValidationEvent } from '@tricigo/api';
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

  // ── Auto-accept preference ──
  const [autoAcceptEnabled, setAutoAcceptEnabled] = useState(false); // false until loaded
  const [autoAcceptLoaded, setAutoAcceptLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('@tricigo/auto_accept_enabled').then((val) => {
      if (val !== null) setAutoAcceptEnabled(val === 'true');
      else setAutoAcceptEnabled(true); // default to true if never set
      setAutoAcceptLoaded(true);
    });
  }, []);

  const toggleAutoAccept = useCallback(async () => {
    const next = !autoAcceptEnabled;
    setAutoAcceptEnabled(next);
    await AsyncStorage.setItem('@tricigo/auto_accept_enabled', String(next));
  }, [autoAcceptEnabled]);

  // ── Auto-accept countdown ──
  const autoAcceptDuration = profitLevel === 'great' ? 8 : profitLevel === 'good' ? 12 : 15;
  const countdownProgress = useRef(new Animated.Value(1)).current;
  const [autoAcceptSecondsLeft, setAutoAcceptSecondsLeft] = useState(autoAcceptDuration);

  // ── Offer-window countdown progress bar ──
  // Bound to the server-issued `offer_expires_at` (ride_offers.expires_at)
  // so the bar reflects the REAL remaining time, not a local 30s timer
  // that skews with network latency. Migration 00120 introduced this;
  // migration 00126 added re-dispatch, which re-seeds expires_at.
  const OFFER_WINDOW_MS = 30_000;
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const expiresAt = ride.offer_expires_at
      ? new Date(ride.offer_expires_at).getTime()
      : null;
    const msLeft = expiresAt ? Math.max(0, expiresAt - Date.now()) : OFFER_WINDOW_MS;
    // Progress goes 0..1 (0 = just received, 1 = expired)
    const initialProgress = Math.max(0, Math.min(1, 1 - msLeft / OFFER_WINDOW_MS));

    progressAnim.setValue(initialProgress);
    Animated.timing(progressAnim, {
      toValue: 1,
      duration: msLeft,
      easing: Easing.linear,
      useNativeDriver: false, // width animation can't use native driver
    }).start();
  }, [ride.id, ride.offer_expires_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleReject = useCallback(() => {
    triggerHaptic('light');
    trackValidationEvent('driver_ride_rejected', {
      profit_level: profitLevel,
      seconds_remaining: autoAcceptSecondsLeft,
      distance_km: distanceKm,
      net_earnings: netEarnings,
    }, ride.id);
    onReject?.(ride.id);
  }, [onReject, ride.id, profitLevel, autoAcceptSecondsLeft, distanceKm, netEarnings]);

  const autoAcceptFiredRef = useRef(false);

  useEffect(() => {
    if (!autoAcceptEnabled || !autoAcceptLoaded) return;
    autoAcceptFiredRef.current = false;
    setAutoAcceptSecondsLeft(autoAcceptDuration);

    countdownProgress.setValue(1);
    Animated.timing(countdownProgress, {
      toValue: 0,
      duration: autoAcceptDuration * 1000,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    }).start();

    const interval = setInterval(() => {
      setAutoAcceptSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          autoAcceptFiredRef.current = true;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAcceptDuration, autoAcceptEnabled, autoAcceptLoaded, ride.id]);

  // Side effects when auto-accept fires (outside setState to avoid render-cycle violations)
  useEffect(() => {
    if (autoAcceptFiredRef.current && autoAcceptSecondsLeft === 0) {
      autoAcceptFiredRef.current = false;
      triggerHaptic('success');
      trackValidationEvent('driver_ride_auto_accepted', {
        profit_level: profitLevel,
        countdown_duration: autoAcceptDuration,
        distance_km: distanceKm,
        net_earnings: netEarnings,
      }, ride.id);
      Toast.show({ type: 'success', text1: t('home.ride_accepted', { defaultValue: '¡Viaje aceptado!' }), visibilityTime: 1500 });
      onAccept(ride.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAcceptSecondsLeft]);

  const profitColor = PROFIT_COLORS[profitLevel];
  const profitIcon = PROFIT_ICONS[profitLevel];

  const profitLabel = profitLevel === 'great'
    ? t('home.profitable_ride', { defaultValue: 'Viaje rentable' })
    : profitLevel === 'short'
      ? t('home.short_ride_reject', { defaultValue: 'Viaje corto' })
      : t('home.available_ride', { defaultValue: 'Viaje disponible' });

  const fare = driverFare.cup || 0;

  // F605: Full card skeleton guard — prevent flash of auto-accept countdown
  const skeletonPulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (!autoAcceptLoaded) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(skeletonPulse, { toValue: 0.8, duration: 800, useNativeDriver: true }),
          Animated.timing(skeletonPulse, { toValue: 0.4, duration: 800, useNativeDriver: true }),
        ]),
      ).start();
    }
  }, [autoAcceptLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!autoAcceptLoaded) {
    return (
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}>
        <Animated.View style={{
          height: 320,
          borderRadius: 16,
          backgroundColor: 'rgba(255,255,255,0.04)',
          opacity: skeletonPulse,
        }} />
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}>
      {/* ── Animated countdown progress bar (green → yellow → red) ── */}
      <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 2, marginBottom: 16, overflow: 'hidden' }}>
        <Animated.View style={{
          height: 4,
          borderRadius: 2,
          width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['100%', '0%'] }),
          // 0..0.66 of elapsed (>=10s left of 30s) = green
          // 0.66..0.83 (5-10s left) = yellow
          // 0.83..1 (<5s) = red
          backgroundColor: progressAnim.interpolate({
            inputRange: [0, 0.66, 0.83, 1],
            outputRange: ['#22c55e', '#22c55e', '#eab308', '#ef4444'],
          }),
        }} />
      </View>

      {/* ── Top: Distance + ETA + Profit indicator ── */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        {distanceKm !== null && (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
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

      {/* ── Net earnings — hero value ──
           UX: add a "Ganás" micro-label so the big number is immediately
           understood as the driver's cut (not the total fare). Without it,
           "$2550" + "Tarifa total: 3,000 CUP" below was ambiguous — drivers
           could mis-read which number they actually take home. */}
      <Text variant="caption" style={{ color: '#9CA3AF', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 2 }}>
        {t('home.net_earnings_label', { defaultValue: 'Ganás' })}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 4, gap: 8 }}>
        <Text variant="stat" style={{ color: profitColor }}>
          ${netEarnings.toLocaleString()}
        </Text>
        {/* Surge badge — when this specific ride has surge > 1x, show it
             next to the hero number so drivers immediately see the bump.
             The big home-screen surge banner only tells them "there's surge
             in the area"; this per-ride badge confirms the offer itself
             includes the multiplier. */}
        {(ride.surge_multiplier ?? 1) > 1 && (
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            backgroundColor: 'rgba(239,68,68,0.2)',
            borderWidth: 1,
            borderColor: 'rgba(239,68,68,0.45)',
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderRadius: 10,
          }}>
            <Ionicons name="flame" size={13} color="#ef4444" />
            <Text variant="caption" style={{ color: '#fecaca', fontWeight: '700' }}>
              {(ride.surge_multiplier ?? 1).toFixed(1)}x
            </Text>
          </View>
        )}
      </View>

      {/* Fare (secondary) — reword to make it clear this is what the
           passenger pays, distinct from what the driver earns. */}
      <View style={{ marginBottom: 16 }} accessible accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: formatCUP(driverFare.cup) })}>
        <Text variant="caption" color="secondary">
          {t('home.passenger_pays', { defaultValue: 'El pasajero paga' })}: {formatCUP(driverFare.cup)}
          {driverFare.trc != null ? ` (~${formatTRC(driverFare.trc)})` : ''}
        </Text>
      </View>

      {/* ── Route: Pickup → Dropoff (vertical dots pattern) ── */}
      <View style={{ marginBottom: 16 }}>
        {/* Pickup row */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }} accessible accessibilityLabel={t('a11y.pickup_address', { ns: 'common', address: ride.pickup_address })}>
          <View style={{ width: 24, alignItems: 'center' }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#22C55E' }} />
          </View>
          <RNText style={{ color: '#fff', fontSize: 14, fontWeight: '500', fontFamily: 'Inter', flex: 1, marginLeft: 8 }} numberOfLines={1}>
            {ride.pickup_address}
          </RNText>
        </View>

        {/* Connecting dashed line */}
        <View style={{ width: 24, alignItems: 'center', paddingVertical: 4 }}>
          <View style={{ width: 1, height: 24, backgroundColor: 'rgba(255,255,255,0.08)' }}>
            {/* Dashed effect via multiple small segments */}
            <View style={{ position: 'absolute', top: 0, width: 1, height: 4, backgroundColor: 'rgba(255,255,255,0.08)' }} />
            <View style={{ position: 'absolute', top: 8, width: 1, height: 4, backgroundColor: 'rgba(255,255,255,0.08)' }} />
            <View style={{ position: 'absolute', top: 16, width: 1, height: 4, backgroundColor: 'rgba(255,255,255,0.08)' }} />
          </View>
        </View>

        {/* Dropoff row */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }} accessible accessibilityLabel={t('a11y.dropoff_address', { ns: 'common', address: ride.dropoff_address })}>
          <View style={{ width: 24, alignItems: 'center' }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.brand.orange }} />
          </View>
          <RNText style={{ color: '#fff', fontSize: 14, fontFamily: 'Inter', flex: 1, marginLeft: 8 }} numberOfLines={1}>
            {ride.dropoff_address}
          </RNText>
        </View>
      </View>

      {/* ── Info badges ── */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <View style={{ backgroundColor: '#252540', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, flexDirection: 'row', alignItems: 'center' }}>
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

        <View style={{ backgroundColor: '#252540', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 }}>
          <Text variant="badge" color="inverse">
            {ride.payment_method === 'cash' ? t('common.cash')
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

      {/* ── Stats row ── */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, marginVertical: 8, borderTopWidth: 1, borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
        <View style={{ alignItems: 'center' }}>
          <RNText style={{ color: '#9CA3AF', fontSize: 11, fontFamily: 'Inter' }}>Distancia</RNText>
          <RNText style={{ color: '#fff', fontSize: 16, fontWeight: '700', fontFamily: 'Inter' }}>
            {ride.estimated_distance_m ? `${(ride.estimated_distance_m / 1000).toFixed(1)} km` : '--'}
          </RNText>
        </View>
        <View style={{ alignItems: 'center' }}>
          <RNText style={{ color: '#9CA3AF', fontSize: 11, fontFamily: 'Inter' }}>ETA</RNText>
          <RNText style={{ color: '#fff', fontSize: 16, fontWeight: '700', fontFamily: 'Inter' }}>
            {ride.estimated_duration_s ? `${Math.round(ride.estimated_duration_s / 60)} min` : '--'}
          </RNText>
        </View>
        <View style={{ alignItems: 'center' }}>
          <RNText style={{ color: '#9CA3AF', fontSize: 11, fontFamily: 'Inter' }}>Tarifa</RNText>
          <RNText style={{ color: colors.brand.orange, fontSize: 16, fontWeight: '700', fontFamily: 'Inter' }}>
            ${fare.toLocaleString()}
          </RNText>
        </View>
      </View>

      {/* ── Auto-accept countdown ── */}
      {!autoAcceptLoaded ? (
        /* Shimmer placeholder while AsyncStorage loads auto-accept preference */
        <View style={{ marginBottom: 12, marginTop: 8, height: 30, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 8 }} />
      ) : autoAcceptEnabled ? (
        <View style={{ marginBottom: 12, marginTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text variant="caption" color="secondary">
              {autoAcceptSecondsLeft > 0
                ? t('home.auto_accepting_in', { seconds: autoAcceptSecondsLeft })
                : t('home.auto_accepting_now', { defaultValue: 'Aceptando viaje...' })}
            </Text>
            <Pressable onPress={toggleAutoAccept} hitSlop={8}>
              <Text variant="badge" style={{ color: colors.neutral[400] }}>
                {t('home.disable_auto_accept', { defaultValue: 'Desactivar' })}
              </Text>
            </Pressable>
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
      ) : autoAcceptLoaded && !autoAcceptEnabled ? (
        <View style={{ marginBottom: 12, marginTop: 8 }}>
          <Pressable
            onPress={toggleAutoAccept}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 6 }}
            hitSlop={8}
          >
            <Ionicons name="timer-outline" size={14} color={colors.neutral[400]} />
            <Text variant="caption" color="secondary" className="ml-1">
              {t('home.enable_auto_accept', { defaultValue: 'Activar auto-aceptar' })}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* ── Action buttons ── */}
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
        {/* Reject button */}
        <Pressable
          style={{
            flex: 1,
            backgroundColor: 'transparent',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.15)',
            borderRadius: 16,
            height: 52,
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onPress={handleReject}
          accessibilityRole="button"
          accessibilityLabel={t('home.reject', { defaultValue: 'Rechazar viaje' })}
          accessibilityHint={t('home.reject_hint', { defaultValue: 'Rechaza este viaje y espera el siguiente' })}
        >
          <RNText style={{ color: '#fff', fontSize: 16, fontWeight: '700', fontFamily: 'Inter' }}>
            {t('home.reject', { defaultValue: 'Rechazar' })}
          </RNText>
        </Pressable>

        {/* Accept button */}
        <Pressable
          style={{
            flex: 1,
            backgroundColor: colors.brand.orange,
            borderRadius: 16,
            height: 52,
            minHeight: 48,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onPress={() => { triggerHaptic('medium'); onAccept(ride.id); }}
          accessibilityRole="button"
          accessibilityLabel={t('home.accept', { defaultValue: 'Aceptar viaje' })}
        >
          <RNText style={{ color: '#fff', fontSize: 16, fontWeight: '700', fontFamily: 'Inter' }}>
            {t('home.accept', { defaultValue: 'Aceptar' })}
          </RNText>
        </Pressable>
      </View>
    </View>
  );
}

export const IncomingRideCard = React.memo(IncomingRideCardInner);

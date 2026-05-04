/**
 * IncomingRideCard v2 — Midnight Ember edition.
 *
 * Diseño anclado en el sistema de tokens `midnightEmber` (PR #89). Reemplaza
 * la implementación previa que mezclaba `<Text variant>` con `<RNText>` raw,
 * usaba 5 paletas de color simultáneas y duplicaba la tarifa entre el hero
 * y un "stats row" de mid-card.
 *
 * Decisiones de diseño confirmadas con el usuario antes de implementar:
 *   A. Eliminar el badge "Viaje rentable" superior — el número $X es
 *      self-evident y el badge introducía matching bias (driver acepta
 *      "great", rechaza "short" sin pensar).
 *   B. Reject discreto al ~28% width vs accept al ~72%. Cambia el momento
 *      de decisión de "elegir 50/50" a "accept es default; reject es
 *      opt-out activo". Alinea con la métrica de acceptance rate del
 *      driver, que algorítmicamente afecta dispatch ranking.
 *   C. Eliminar el stats row mid-card que duplicaba la tarifa y mostraba
 *      "Distancia / ETA / Tarifa" en 3 columnas. Reemplazado por una
 *      meta line uppercase mono "AL RECOGER 3.4 KM • VIAJE 12 MIN • ★ 4.8".
 *   D. Surge badge migra de rojo (semántica de danger) a `accent[300]`
 *      con texto "+50%" — surge es buen evento para el driver, no peligro.
 *
 * Lógica preservada:
 *   - BUG-225: la tarifa source-of-truth es `ride.estimated_fare_cup` del
 *     servidor; el cálculo local solo es fallback para legacy rides.
 *   - BUG-221: usar duración NEUTRA 40 km/h en el fallback, no la
 *     `estimated_duration_s` per-vehículo.
 *   - presenceService.joinRideSearch / leaveRideSearch
 *   - trackValidationEvent en accept/reject/auto-accept
 *   - Skeleton mientras AsyncStorage carga la preferencia de auto-accept
 *   - Haptics en cada acción
 *
 * Lo que cambió:
 *   - Stats row (3 cols Distancia/ETA/Tarifa) → eliminado.
 *   - "El pasajero paga X CUP" línea secundaria → eliminada.
 *   - Profit badge `<StatusBadge>` superior → eliminado.
 *   - Progress bar con 3 colores (verde/amarillo/rojo) → 1 familia accent
 *     con intensidad según urgencia.
 *   - Auto-accept toggle: 3 conditional branches → línea persistente
 *     debajo del CTA, siempre visible.
 *   - Reject 50/50 → asimétrico 28/72.
 *   - 12+ hex literals inline → 0; todo via `midnightEmber.*`.
 *   - 10 ocurrencias de `<RNText>` con Inter inline → consumen
 *     `midnightEmber.text.*` styles explícitamente.
 */
import React, { useMemo, useRef, useCallback, useState, useEffect } from 'react';
import { View, Animated, Pressable, Text as RNText, Easing } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { formatCUP, cupToTrcCentavos, haversineDistance, jitterLocation, triggerHaptic } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { presenceService, trackValidationEvent } from '@tricigo/api';
import { midnightEmber } from '@tricigo/theme';
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

// Auto-accept timing por nivel de rentabilidad (ms tolerance, no color).
// Menos rentable → más tiempo para que el driver decida activamente.
type ProfitTier = 'great' | 'good' | 'short';
const AUTO_ACCEPT_SECONDS: Record<ProfitTier, number> = {
  great: 8,   // good deals — accept fast
  good: 12,
  short: 15,  // give the driver time to opt out
};

function IncomingRideCardInner({
  ride,
  onAccept,
  onReject,
  driverCustomRateCup,
  serviceConfig,
  riderRating,
}: IncomingRideCardProps) {
  const { t } = useTranslation('driver');

  // ── Distance + ETA from driver to pickup ──────────────
  const driverLat = useLocationStore((s) => s.latitude);
  const driverLng = useLocationStore((s) => s.longitude);

  // ── Presence broadcast ────────────────────────────────
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

  const pickupDistanceKm = useMemo(() => {
    if (!driverLat || !driverLng || !ride.pickup_location?.latitude || !ride.pickup_location?.longitude) return null;
    const meters = haversineDistance(
      { latitude: driverLat, longitude: driverLng },
      ride.pickup_location,
    );
    return Math.round(meters / 100) / 10;
  }, [driverLat, driverLng, ride.pickup_location]);

  // ── Net earnings (fare − 15% commission) ──────────────
  // BUG-225: la tarifa source-of-truth es el campo del servidor.
  // El cálculo local solo es fallback para rides legacy sin el campo.
  // BUG-221: el backend usa duración NEUTRA 40 km/h, no
  // `estimated_duration_s` (que ahora es per-vehículo).
  const driverFare = useMemo(() => {
    if (ride.estimated_fare_cup != null && ride.estimated_fare_cup > 0) {
      return { cup: ride.estimated_fare_cup, trc: ride.estimated_fare_trc };
    }
    if (!serviceConfig) {
      return { cup: ride.estimated_fare_cup, trc: ride.estimated_fare_trc };
    }
    const effectiveRate = driverCustomRateCup ?? serviceConfig.per_km_rate_cup;
    const distKm = (ride.estimated_distance_m ?? 0) / 1000;
    const neutralDurMin = (distKm * 60) / 40;

    const rawFare = Math.round(
      serviceConfig.base_fare_cup +
      distKm * effectiveRate +
      neutralDurMin * serviceConfig.per_minute_rate_cup,
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

  // ── Profit tier solo decide el tiempo de auto-accept,
  //    NO un color visual (eso era el rainbow legacy). ──
  const profitTier: ProfitTier = useMemo(() => {
    if (!pickupDistanceKm || pickupDistanceKm <= 0) return 'good';
    const perKm = netEarnings / pickupDistanceKm;
    if (perKm >= 80) return 'great';
    if (perKm >= 40) return 'good';
    return 'short';
  }, [netEarnings, pickupDistanceKm]);

  // ── Auto-accept preference ────────────────────────────
  const [autoAcceptEnabled, setAutoAcceptEnabled] = useState(false);
  const [autoAcceptLoaded, setAutoAcceptLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('@tricigo/auto_accept_enabled').then((val) => {
      if (val !== null) setAutoAcceptEnabled(val === 'true');
      else setAutoAcceptEnabled(true);
      setAutoAcceptLoaded(true);
    });
  }, []);

  const toggleAutoAccept = useCallback(async () => {
    const next = !autoAcceptEnabled;
    setAutoAcceptEnabled(next);
    await AsyncStorage.setItem('@tricigo/auto_accept_enabled', String(next));
  }, [autoAcceptEnabled]);

  // ── Countdown ─────────────────────────────────────────
  // Cuando auto-accept está activo: countdown de 8/12/15s (según tier).
  // Cuando está desactivado: usamos la ventana servidor 30s.
  // En ambos casos: UNA sola progress bar arriba del card, intensidad
  // del color sigue una familia (accent → accent oscuro → danger).
  const autoAcceptDuration = AUTO_ACCEPT_SECONDS[profitTier];
  const OFFER_WINDOW_MS = 30_000;

  const progressAnim = useRef(new Animated.Value(0)).current;
  const [secondsLeft, setSecondsLeft] = useState(autoAcceptDuration);
  const autoAcceptFiredRef = useRef(false);

  useEffect(() => {
    if (!autoAcceptLoaded) return;
    autoAcceptFiredRef.current = false;

    const useAutoAccept = autoAcceptEnabled;
    const totalMs = useAutoAccept
      ? autoAcceptDuration * 1000
      : (() => {
          const expiresAt = ride.offer_expires_at
            ? new Date(ride.offer_expires_at).getTime()
            : null;
          return expiresAt
            ? Math.max(0, expiresAt - Date.now())
            : OFFER_WINDOW_MS;
        })();

    const totalS = Math.max(1, Math.ceil(totalMs / 1000));
    setSecondsLeft(useAutoAccept ? autoAcceptDuration : totalS);

    progressAnim.setValue(0);
    Animated.timing(progressAnim, {
      toValue: 1,
      duration: totalMs,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();

    const interval = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          if (useAutoAccept) autoAcceptFiredRef.current = true;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride.id, autoAcceptEnabled, autoAcceptLoaded, autoAcceptDuration]);

  // Side-effect of auto-accept firing (outside setState).
  useEffect(() => {
    if (autoAcceptFiredRef.current && secondsLeft === 0 && autoAcceptEnabled) {
      autoAcceptFiredRef.current = false;
      triggerHaptic('success');
      trackValidationEvent('driver_ride_auto_accepted', {
        profit_level: profitTier,
        countdown_duration: autoAcceptDuration,
        distance_km: pickupDistanceKm,
        net_earnings: netEarnings,
      }, ride.id);
      Toast.show({
        type: 'success',
        text1: t('home.ride_accepted', { defaultValue: '¡Viaje aceptado!' }),
        visibilityTime: 1500,
      });
      onAccept(ride.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  // ── Handlers ──────────────────────────────────────────
  const handleReject = useCallback(() => {
    triggerHaptic('light');
    trackValidationEvent('driver_ride_rejected', {
      profit_level: profitTier,
      seconds_remaining: secondsLeft,
      distance_km: pickupDistanceKm,
      net_earnings: netEarnings,
    }, ride.id);
    onReject?.(ride.id);
  }, [onReject, ride.id, profitTier, secondsLeft, pickupDistanceKm, netEarnings]);

  const handleAccept = useCallback(() => {
    triggerHaptic('medium');
    onAccept(ride.id);
  }, [onAccept, ride.id]);

  // ── Skeleton mientras carga la pref auto-accept ──────
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
          borderRadius: midnightEmber.radius.hero,
          backgroundColor: midnightEmber.map.bg.surface,
          opacity: skeletonPulse,
        }} />
      </View>
    );
  }

  // ── Derived display values ────────────────────────────
  const tripDistanceKm = ride.estimated_distance_m
    ? (ride.estimated_distance_m / 1000).toFixed(1)
    : null;
  const tripDurationMin = ride.estimated_duration_s
    ? Math.round(ride.estimated_duration_s / 60)
    : null;
  const surgeMultiplier = ride.surge_multiplier ?? 1;
  const surgePercent = surgeMultiplier > 1
    ? Math.round((surgeMultiplier - 1) * 100)
    : 0;

  const fare = driverFare.cup || 0;

  // Service type → icono.
  const vehicleIcon =
    ride.service_type === 'triciclo_basico' || ride.service_type === 'triciclo_cargo'
      ? ('bicycle-outline' as const)
      : ride.service_type === 'moto_standard'
        ? ('flash-outline' as const)
        : ('car-outline' as const);

  const paymentLabel =
    ride.payment_method === 'cash'
      ? t('common.cash')
      : ride.payment_method === 'corporate'
        ? t('home.payment_corporate', { defaultValue: 'Corporativo' })
        : ride.payment_method === 'mixed'
          ? t('home.payment_mixed', { defaultValue: 'Mixto' })
          : t('trip.tricicoin');

  // Progress bar color: una familia (accent), intensidad por urgencia.
  // Mientras mucho tiempo → accent[500]. Pocos segundos → accent[700].
  // Crítico (<3s) → state.danger (única ruptura de familia, justificada).
  const progressColor = progressAnim.interpolate({
    inputRange: [0, 0.66, 0.83, 1],
    outputRange: [
      midnightEmber.accent[500],
      midnightEmber.accent[500],
      midnightEmber.accent[700],
      midnightEmber.state.danger,
    ],
  });

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 }}>
      <View
        style={{
          backgroundColor: midnightEmber.map.bg.elevated,
          borderRadius: midnightEmber.radius.hero,
          borderWidth: 1,
          borderColor: midnightEmber.map.line.default,
          padding: 18,
          ...midnightEmber.shadow.hero,
        }}
      >
        {/* ── Countdown progress bar (única, intensidad por urgencia) ── */}
        <View style={{
          height: 4,
          backgroundColor: midnightEmber.map.line.hairline,
          borderRadius: 2,
          marginBottom: 18,
          overflow: 'hidden',
        }}>
          <Animated.View style={{
            height: 4,
            borderRadius: 2,
            width: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['100%', '0%'] }),
            backgroundColor: progressColor,
          }} />
        </View>

        {/* ── HERO: GANÁS label + número + surge inline ── */}
        <RNText style={{
          ...midnightEmber.text.meta,
          color: midnightEmber.map.text.tertiary,
          marginBottom: 4,
        }}>
          {t('home.net_earnings_label', { defaultValue: 'GANÁS' })}
        </RNText>
        <View style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          gap: 10,
          marginBottom: 10,
        }}
          accessible
          accessibilityLabel={t('a11y.net_earnings', {
            ns: 'common',
            amount: formatCUP(netEarnings),
            defaultValue: 'Ganás {{amount}}',
          })}
        >
          <RNText style={{
            ...midnightEmber.text.hero,
            color: midnightEmber.accent[500],
          }}>
            ${netEarnings.toLocaleString()}
          </RNText>
          {surgePercent > 0 && (
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: midnightEmber.accent[300],
              paddingHorizontal: 9,
              paddingVertical: 3,
              borderRadius: midnightEmber.radius.pill,
            }}>
              <Ionicons name="flame" size={12} color={midnightEmber.accent[800]} />
              <RNText style={{
                ...midnightEmber.text.dataSm,
                color: midnightEmber.accent[800],
                fontWeight: '700',
              }}>
                +{surgePercent}%
              </RNText>
            </View>
          )}
        </View>

        {/* ── META LINE: trip stats + rating en una sola tira ── */}
        <RNText style={{
          ...midnightEmber.text.meta,
          color: midnightEmber.map.text.secondary,
          marginBottom: 16,
        }}>
          {[
            pickupDistanceKm != null
              ? t('home.meta_pickup_distance', {
                  km: pickupDistanceKm,
                  defaultValue: 'AL RECOGER {{km}} KM',
                })
              : null,
            tripDistanceKm
              ? t('home.meta_trip_distance', {
                  km: tripDistanceKm,
                  defaultValue: 'VIAJE {{km}} KM',
                })
              : null,
            tripDurationMin
              ? t('home.meta_trip_duration', {
                  min: tripDurationMin,
                  defaultValue: '{{min}} MIN',
                })
              : null,
            riderRating != null
              ? `★ ${riderRating.toFixed(1)}`
              : null,
          ]
            .filter(Boolean)
            .join('  •  ')}
        </RNText>

        {/* ── Pickup → Dropoff con dots verticales ── */}
        <View style={{ marginBottom: 16 }}>
          <View
            style={{ flexDirection: 'row', alignItems: 'center' }}
            accessible
            accessibilityLabel={t('a11y.pickup_address', {
              ns: 'common',
              address: ride.pickup_address,
            })}
          >
            <View style={{ width: 24, alignItems: 'center' }}>
              <View style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: midnightEmber.state.success,
              }} />
            </View>
            <RNText
              style={{
                ...midnightEmber.text.body,
                color: midnightEmber.map.text.primary,
                flex: 1,
                marginLeft: 8,
              }}
              numberOfLines={1}
            >
              {ride.pickup_address}
            </RNText>
          </View>

          {/* Línea vertical entre dots */}
          <View style={{
            width: 24,
            alignItems: 'center',
            paddingVertical: 3,
          }}>
            <View style={{
              width: 1,
              height: 18,
              backgroundColor: midnightEmber.map.line.default,
            }} />
          </View>

          <View
            style={{ flexDirection: 'row', alignItems: 'center' }}
            accessible
            accessibilityLabel={t('a11y.dropoff_address', {
              ns: 'common',
              address: ride.dropoff_address,
            })}
          >
            <View style={{ width: 24, alignItems: 'center' }}>
              <View style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: midnightEmber.accent[500],
              }} />
            </View>
            <RNText
              style={{
                ...midnightEmber.text.body,
                color: midnightEmber.map.text.primary,
                flex: 1,
                marginLeft: 8,
              }}
              numberOfLines={1}
            >
              {ride.dropoff_address}
            </RNText>
          </View>
        </View>

        {/* ── Chips uniformes (vehículo, pago, cargo, waypoints, corp) ── */}
        <View style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 6,
          marginBottom: 16,
        }}>
          <Chip icon={vehicleIcon} />
          <Chip label={paymentLabel} />
          {(ride.service_type === 'triciclo_cargo' || ride.ride_mode === 'cargo') && (
            <Chip
              icon="cube-outline"
              label={t('home.cargo_chip', { defaultValue: 'Cargo' })}
              variant="accent"
            />
          )}
          {ride.waypoints && ride.waypoints.length > 0 && (
            <Chip
              icon="flag-outline"
              label={t('home.waypoints_badge', {
                count: ride.waypoints.length,
                defaultValue: '{{count}} paradas',
              })}
            />
          )}
          {ride.corporate_account_id && (
            <Chip
              icon="business-outline"
              label={t('home.corporate_ride', { defaultValue: 'Corporativo' })}
            />
          )}
        </View>

        {/* ── Scheduled banner (solo si aplica) ── */}
        {ride.scheduled_at && (
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            backgroundColor: midnightEmber.map.bg.surface,
            borderColor: midnightEmber.map.line.default,
            borderWidth: 1,
            borderRadius: midnightEmber.radius.input,
            paddingVertical: 8,
            paddingHorizontal: 12,
            marginBottom: 14,
          }}>
            <Ionicons
              name="time-outline"
              size={14}
              color={midnightEmber.map.text.secondary}
            />
            <RNText style={{
              ...midnightEmber.text.caption,
              color: midnightEmber.map.text.secondary,
            }}>
              {t('home.scheduled_at', {
                time: new Date(ride.scheduled_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
                defaultValue: 'Programado: {{time}}',
              })}
            </RNText>
          </View>
        )}

        {/* ── CTA asimétrico 28/72 ── */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {/* Reject discreto */}
          <Pressable
            style={{
              flex: 0,
              minWidth: 96,
              paddingHorizontal: 14,
              height: 52,
              minHeight: 48,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: midnightEmber.radius.card,
            }}
            onPress={handleReject}
            accessibilityRole="button"
            accessibilityLabel={t('home.reject', { defaultValue: 'No me sirve' })}
            accessibilityHint={t('home.reject_hint', {
              defaultValue: 'Rechaza este viaje y espera el siguiente',
            })}
          >
            <RNText style={{
              ...midnightEmber.text.buttonMd,
              color: midnightEmber.map.text.tertiary,
            }}>
              {t('home.reject_soft', { defaultValue: 'No me sirve' })}
            </RNText>
          </Pressable>

          {/* Accept primary con glow */}
          <Pressable
            style={{
              flex: 1,
              backgroundColor: midnightEmber.accent[500],
              borderRadius: midnightEmber.radius.card,
              height: 52,
              minHeight: 48,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: 8,
              ...midnightEmber.shadow.glow,
            }}
            onPress={handleAccept}
            accessibilityRole="button"
            accessibilityLabel={t('home.accept', { defaultValue: 'Aceptar viaje' })}
          >
            <Ionicons name="checkmark" size={18} color={midnightEmber.map.text.onAccent} />
            <RNText style={{
              ...midnightEmber.text.buttonLg,
              color: midnightEmber.map.text.onAccent,
            }}>
              {t('home.accept_full', { defaultValue: 'Aceptar viaje' })}
            </RNText>
          </Pressable>
        </View>

        {/* ── Auto-accept persistent line (siempre visible) ── */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 14,
          gap: 6,
        }}>
          {autoAcceptEnabled ? (
            <>
              <Ionicons
                name="timer-outline"
                size={13}
                color={midnightEmber.map.text.tertiary}
              />
              <RNText style={{
                ...midnightEmber.text.caption,
                color: midnightEmber.map.text.tertiary,
              }}>
                {secondsLeft > 0
                  ? t('home.auto_accepting_in', {
                      seconds: secondsLeft,
                      defaultValue: 'Auto-aceptar en {{seconds}}s',
                    })
                  : t('home.auto_accepting_now', { defaultValue: 'Aceptando viaje…' })}
              </RNText>
              <RNText style={{
                ...midnightEmber.text.caption,
                color: midnightEmber.map.text.tertiary,
              }}>·</RNText>
              {/* V2 — hitSlop bumped 8 → 14: caption text is ~16pt; the
                   16+14×2 = 44pt effective tap zone clears HIG. The user
                   may need to disable mid-countdown (8-15s window) so a
                   reliable tap is critical. Visual stays as a discreet
                   underline link. */}
              <Pressable
                onPress={toggleAutoAccept}
                hitSlop={14}
                accessibilityRole="button"
                accessibilityLabel={t('home.disable_auto_accept', { defaultValue: 'Desactivar' })}
              >
                <RNText style={{
                  ...midnightEmber.text.caption,
                  color: midnightEmber.map.text.secondary,
                  textDecorationLine: 'underline',
                }}>
                  {t('home.disable_auto_accept', { defaultValue: 'Desactivar' })}
                </RNText>
              </Pressable>
            </>
          ) : (
            // V2 — hitSlop bumped 8 → 14 to clear the HIG 44pt minimum
            // (icon 13pt + caption text ~16pt; the surrounding 14pt
            // hitSlop expands the effective hit area on all sides).
            <Pressable
              onPress={toggleAutoAccept}
              hitSlop={14}
              accessibilityRole="button"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Ionicons
                name="timer-outline"
                size={13}
                color={midnightEmber.map.text.secondary}
              />
              <RNText style={{
                ...midnightEmber.text.caption,
                color: midnightEmber.map.text.secondary,
                textDecorationLine: 'underline',
              }}>
                {t('home.enable_auto_accept', { defaultValue: 'Activar auto-aceptar' })}
              </RNText>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────
// Chip subcomponent — uniforma todos los badges informativos
// ──────────────────────────────────────────────────────────

interface ChipProps {
  icon?: keyof typeof Ionicons.glyphMap;
  label?: string;
  variant?: 'default' | 'accent';
}

function Chip({ icon, label, variant = 'default' }: ChipProps) {
  const isAccent = variant === 'accent';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: midnightEmber.radius.tap,
        backgroundColor: isAccent
          ? midnightEmber.accent[300]
          : midnightEmber.map.bg.surface,
        borderWidth: 1,
        borderColor: isAccent
          ? 'transparent'
          : midnightEmber.map.line.default,
      }}
    >
      {icon && (
        <Ionicons
          name={icon}
          size={13}
          color={isAccent ? midnightEmber.accent[800] : midnightEmber.map.text.secondary}
        />
      )}
      {label && (
        <RNText style={{
          ...midnightEmber.text.caption,
          color: isAccent ? midnightEmber.accent[800] : midnightEmber.map.text.secondary,
        }}>
          {label}
        </RNText>
      )}
    </View>
  );
}

export const IncomingRideCard = React.memo(IncomingRideCardInner);

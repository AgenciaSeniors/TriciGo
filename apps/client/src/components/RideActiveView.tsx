import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Pressable, Linking, Alert, ActivityIndicator, useColorScheme, Dimensions, Animated } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { formatTRC, haversineDistance, logger } from '@tricigo/utils';
import { RIDE_CONFIG } from '@/config/ride';
import { useTranslation } from '@tricigo/i18n';
import Toast from 'react-native-toast-message';
import { incidentService, rideService, customerService, getSupabaseClient } from '@tricigo/api';
import { useRideStore } from '@/stores/ride.store';
import { useRideActions } from '@/hooks/useRide';
import { useAuthStore } from '@/stores/auth.store';
import { RideMapView } from '@/components/RideMapView';
import { useDriverPositionWithCache } from '@/hooks/useDriverPosition';
import { formatTimeAgo } from '@tricigo/utils/offlineLabels';
import { useRoutePolyline } from '@/hooks/useRoutePolyline';
import { useETA } from '@/hooks/useETA';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { ETABadge } from '@tricigo/ui/ETABadge';
import { IconButton } from '@tricigo/ui/IconButton';
import { DriverCard } from '@tricigo/ui/DriverCard';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { CancelRideSheet } from '@/components/CancelRideSheet';
import { SafetySheet } from '@/components/SafetySheet';
import { AddressSearchInput } from '@/components/AddressSearchInput';
import type { GeoPoint } from '@tricigo/utils';

export function RideActiveView() {
  const { t } = useTranslation('rider');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const RIDE_STEPS = [
    { key: 'accepted', label: t('ride.status_accepted') },
    { key: 'driver_en_route', label: t('ride.status_driver_en_route') },
    { key: 'arrived_at_pickup', label: t('ride.status_arrived_at_pickup') },
    { key: 'in_progress', label: t('ride.status_in_progress') },
  ];
  const activeRide = useRideStore((s) => s.activeRide);
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);
  const isLoading = useRideStore((s) => s.isLoading);
  const addSplit = useRideStore((s) => s.addSplit);
  const updateSplit = useRideStore((s) => s.updateSplit);
  const setSplits = useRideStore((s) => s.setSplits);
  const userId = useAuthStore((s) => s.user?.id);
  const { cancelRide } = useRideActions();
  const driverPosState = useDriverPositionWithCache(activeRide?.id ?? null);
  const driverPosition = driverPosState.position;
  const routeCoordinates = useRoutePolyline(
    activeRide?.pickup_location ?? null,
    activeRide?.dropoff_location ?? null,
  );
  const { etaMinutes, isCalculating } = useETA({
    driverLocation: driverPosition,
    pickupLocation: activeRide?.pickup_location ?? null,
    dropoffLocation: activeRide?.dropoff_location ?? null,
    rideStatus: activeRide?.status ?? null,
    estimatedDurationS: activeRide?.estimated_duration_s,
  });

  // X3.2: Dynamic map height — 40% of screen
  const mapHeight = Math.round(Dimensions.get('window').height * 0.4);

  // X3.3: ETA pulse animation when < 3 minutes
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => {
    if (etaMinutes !== null && etaMinutes > 0 && etaMinutes < 3) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.05, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ]),
      );
      pulseLoopRef.current = loop;
      loop.start();
    } else {
      if (pulseLoopRef.current) {
        pulseLoopRef.current.stop();
        pulseLoopRef.current = null;
      }
      pulseAnim.setValue(1);
    }
    return () => {
      if (pulseLoopRef.current) {
        pulseLoopRef.current.stop();
        pulseLoopRef.current = null;
      }
    };
  }, [etaMinutes, pulseAnim]);

  // X2.1: Driver position timeout — show message instead of spinner after 30s
  const [positionTimeoutReached, setPositionTimeoutReached] = useState(false);
  const positionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (driverPosition) {
      // Position received — clear timeout and reset flag
      if (positionTimeoutRef.current) {
        clearTimeout(positionTimeoutRef.current);
        positionTimeoutRef.current = null;
      }
      setPositionTimeoutReached(false);
      return;
    }

    // driverPosition is null and ride is in accepted or driver_en_route
    if (
      activeRide?.status === 'accepted' ||
      activeRide?.status === 'driver_en_route'
    ) {
      if (!positionTimeoutRef.current) {
        positionTimeoutRef.current = setTimeout(() => {
          setPositionTimeoutReached(true);
          positionTimeoutRef.current = null;
        }, RIDE_CONFIG.POSITION_TIMEOUT_MS);
      }
    }

    return () => {
      if (positionTimeoutRef.current) {
        clearTimeout(positionTimeoutRef.current);
        positionTimeoutRef.current = null;
      }
    };
  }, [driverPosition, activeRide?.status]);

  // Driver-not-moving detection (4.2)
  const prevDriverPosRef = useRef<{ latitude: number; longitude: number; timestamp: number } | null>(null);
  const [driverNotMoving, setDriverNotMoving] = useState(false);

  useEffect(() => {
    if (!driverPosition || activeRide?.status !== 'driver_en_route') {
      // Reset when not in driver_en_route status or no position
      prevDriverPosRef.current = null;
      setDriverNotMoving(false);
      return;
    }

    const now = Date.now();
    const prev = prevDriverPosRef.current;

    if (!prev) {
      prevDriverPosRef.current = { latitude: driverPosition.latitude, longitude: driverPosition.longitude, timestamp: now };
      return;
    }

    const dist = haversineDistance(
      { latitude: prev.latitude, longitude: prev.longitude },
      { latitude: driverPosition.latitude, longitude: driverPosition.longitude },
    );

    if (dist > RIDE_CONFIG.DRIVER_NOT_MOVING_THRESHOLD_M) {
      // Driver moved significantly — reset tracking
      prevDriverPosRef.current = { latitude: driverPosition.latitude, longitude: driverPosition.longitude, timestamp: now };
      setDriverNotMoving(false);
    } else {
      // Driver hasn't moved much — check if 5 minutes have passed
      const elapsedMs = now - prev.timestamp;
      if (elapsedMs >= RIDE_CONFIG.DRIVER_NOT_MOVING_TIMEOUT_MS) {
        setDriverNotMoving(true);
      }
    }
  }, [driverPosition, activeRide?.status]);

  // Stale position detection (4.3) — position older than 60s
  const positionIsStale = driverPosState.isCached && driverPosState.cachedAt
    ? (Date.now() - new Date(driverPosState.cachedAt).getTime()) > 60_000
    : false;

  // Waypoints state
  const [waypoints, setWaypoints] = useState<Array<{ id: string; address: string; sort_order: number; latitude: number; longitude: number; arrived_at?: string | null; departed_at?: string | null }>>([]);
  const [addStopVisible, setAddStopVisible] = useState(false);
  const [addingStop, setAddingStop] = useState(false);

  // X1.6: Use refs for subscription channels to ensure proper cleanup on ride change
  const waypointChannelRef = useRef<ReturnType<typeof rideService.subscribeToWaypoints> | null>(null);
  const splitChannelRef = useRef<ReturnType<typeof rideService.subscribeToSplits> | null>(null);

  // Fetch existing waypoints + subscribe to inserts AND updates (driver arrive/depart)
  useEffect(() => {
    // Clean up previous subscription before creating a new one
    if (waypointChannelRef.current) {
      const supabase = getSupabaseClient();
      supabase.removeChannel(waypointChannelRef.current);
      waypointChannelRef.current = null;
    }

    if (!activeRide) return;
    rideService.getRideWaypoints(activeRide.id)
      .then((wps) => setWaypoints(wps))
      .catch(() => {});

    waypointChannelRef.current = rideService.subscribeToWaypoints(
      activeRide.id,
      (newWp) => {
        setWaypoints((prev) => [...prev, newWp]);
      },
      (updatedWp) => {
        setWaypoints((prev) =>
          prev.map((wp) => (wp.id === updatedWp.id ? { ...wp, ...updatedWp } : wp)),
        );
      },
    );

    return () => {
      if (waypointChannelRef.current) {
        const supabase = getSupabaseClient();
        supabase.removeChannel(waypointChannelRef.current);
        waypointChannelRef.current = null;
      }
    };
  }, [activeRide?.id]);

  // Subscribe to real-time split changes (invitations, acceptances, payments)
  useEffect(() => {
    // Clean up previous subscription before creating a new one
    if (splitChannelRef.current) {
      const supabase = getSupabaseClient();
      supabase.removeChannel(splitChannelRef.current);
      splitChannelRef.current = null;
    }

    if (!activeRide?.id || !activeRide.is_split) return;

    // Fetch existing splits
    rideService.getSplitsForRide(activeRide.id)
      .then((existingSplits) => setSplits(existingSplits))
      .catch(() => {});

    splitChannelRef.current = rideService.subscribeToSplits(
      activeRide.id,
      (newSplit) => addSplit(newSplit),
      (updatedSplit) => updateSplit(updatedSplit),
    );

    return () => {
      if (splitChannelRef.current) {
        const supabase = getSupabaseClient();
        supabase.removeChannel(splitChannelRef.current);
        splitChannelRef.current = null;
      }
    };
  }, [activeRide?.id, activeRide?.is_split]);

  const handleAddStop = async (address: string, location: GeoPoint) => {
    if (!activeRide) return;
    setAddingStop(true);
    try {
      const wp = await rideService.addWaypointToActiveRide(
        activeRide.id,
        address,
        location.latitude,
        location.longitude,
      );
      setWaypoints((prev) => [...prev, wp]);
      setAddStopVisible(false);
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown> | null;
      if (typeof errObj?.message === 'string' && errObj.message === 'MAX_WAYPOINTS_REACHED') {
        Alert.alert('', t('ride.max_stops_active', { defaultValue: 'Máximo de paradas alcanzado' }));
      }
    } finally {
      setAddingStop(false);
    }
  };

  // Cancel sheet state
  const [cancelSheetVisible, setCancelSheetVisible] = useState(false);
  const [penaltyPreview, setPenaltyPreview] = useState({ penaltyAmount: 0, cancelCount24h: 0 });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [cancellationFeePreview, setCancellationFeePreview] = useState<import('@tricigo/types').CancellationFeePreview | null>(null);

  // Safety sheet state
  const [safetySheetVisible, setSafetySheetVisible] = useState(false);
  const [emergencyContact, setEmergencyContact] = useState<{ name: string; phone: string } | null>(null);

  // Load emergency contact
  useEffect(() => {
    if (!userId) return;
    customerService.ensureProfile(userId).then((cp) => {
      if (cp.emergency_contact) {
        setEmergencyContact({ name: cp.emergency_contact.name, phone: cp.emergency_contact.phone });
      }
    }).catch(() => {});
  }, [userId]);

  // U2.3: Slide-up entrance animation for driver card
  const slideUpAnim = useRef(new Animated.Value(100)).current;

  useEffect(() => {
    if (rideWithDriver?.driver_name) {
      slideUpAnim.setValue(100);
      Animated.spring(slideUpAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 50,
        friction: 8,
      }).start();
    }
  }, [rideWithDriver?.driver_name, slideUpAnim]);

  if (!activeRide) return null;

  const canCancel =
    activeRide.status === 'accepted' ||
    activeRide.status === 'driver_en_route' ||
    activeRide.status === 'arrived_at_pickup';

  const handleCall = () => {
    if (rideWithDriver?.driver_phone) {
      Linking.openURL(`tel:${rideWithDriver.driver_phone}`);
    }
  };

  const handleSOS = () => {
    Alert.alert(
      t('ride.sos_title'),
      t('ride.sos_body'),
      [
        { text: t('ride.sos_cancel'), style: 'cancel' },
        {
          text: t('ride.sos_call_emergency'),
          style: 'destructive',
          onPress: async () => {
            if (userId) {
              incidentService.createSOSReport({
                ride_id: activeRide.id,
                reported_by: userId,
                against_user_id: activeRide.driver_id ?? undefined,
                description: 'SOS activado por pasajero durante viaje',
              }).catch((err) => {
                logger.error('SOS report failed', { error: String(err) });
                Toast.show({ type: 'error', text1: t('errors.sos_report_failed', { ns: 'common' }) });
              });
            }
            Linking.openURL('tel:106');
          },
        },
      ],
    );
  };

  const handleCancelPress = async () => {
    if (!userId) return;
    setPreviewLoading(true);
    try {
      // Fetch both penalty preview and cancellation fee in parallel
      const [penaltyResult, feeResult] = await Promise.allSettled([
        rideService.previewCancelPenalty(userId),
        activeRide ? rideService.previewCancellationFee(activeRide.id, userId) : Promise.resolve(null),
      ]);

      setPenaltyPreview(
        penaltyResult.status === 'fulfilled'
          ? { penaltyAmount: penaltyResult.value.penaltyAmount, cancelCount24h: penaltyResult.value.cancelCount24h }
          : { penaltyAmount: 0, cancelCount24h: 0 },
      );

      setCancellationFeePreview(
        feeResult.status === 'fulfilled' ? feeResult.value : null,
      );
    } catch {
      setPenaltyPreview({ penaltyAmount: 0, cancelCount24h: 0 });
      setCancellationFeePreview(null);
    } finally {
      setPreviewLoading(false);
      setCancelSheetVisible(true);
    }
  };

  const handleCancelConfirm = (reason: string) => {
    setCancelSheetVisible(false);
    cancelRide(reason);
  };

  const statusMessage: Record<string, string> = {
    accepted: t('ride.driver_assigned'),
    driver_en_route: t('ride.driver_arriving'),
    arrived_at_pickup: t('ride.driver_arrived'),
    in_progress: t('ride.in_progress'),
  };

  return (
    <View className="flex-1 pt-4">
      {/* Floating SOS button (4.1) — always visible during active ride */}
      <Pressable
        onPress={handleSOS}
        style={{
          position: 'absolute',
          top: 60,
          right: 16,
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: '#DC2626',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          elevation: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.3,
          shadowRadius: 4,
        }}
        accessibilityRole="button"
        accessibilityLabel={t('ride.sos_activate', { defaultValue: '¿Activar SOS?' })}
      >
        <Text style={{ color: 'white', fontWeight: 'bold', fontSize: 16 }}>SOS</Text>
      </Pressable>

      {/* Live map with route polyline */}
      <View style={{ position: 'relative' }}>
        <RideMapView
          pickupLocation={activeRide.pickup_location}
          dropoffLocation={activeRide.dropoff_location}
          driverLocation={driverPosition}
          driverMarkerOpacity={driverPosState.isCached ? 0.6 : 1}
          routeCoordinates={routeCoordinates}
          height={mapHeight}
        />
        {!driverPosition && (
          <View
            className="absolute inset-0 items-center justify-center bg-neutral-100/80"
            style={{ borderRadius: 12 }}
          >
            {positionTimeoutReached ? (
              <Text variant="caption" color="secondary" className="mt-2 px-4 text-center">
                {t('errors.waiting_driver_location', { ns: 'common', defaultValue: 'Esperando ubicación del conductor...' })}
              </Text>
            ) : (
              <>
                <ActivityIndicator size="small" color={isDark ? '#FB923C' : '#F97316'} />
                <Text variant="caption" color="secondary" className="mt-2">
                  {t('ride.loading_map', { defaultValue: 'Cargando mapa...' })}
                </Text>
              </>
            )}
          </View>
        )}
      </View>
      {positionIsStale && (
        <View
          className="flex-row items-center justify-center mt-2 mx-4 px-3 py-2 rounded-lg"
          style={{ backgroundColor: isDark ? '#92400E' : '#FEF3C7' }}
        >
          <Ionicons name="warning-outline" size={16} color={isDark ? '#FDE68A' : '#92400E'} />
          <Text variant="caption" className="ml-1 font-semibold" style={{ color: isDark ? '#FDE68A' : '#92400E' }}>
            {t('ride.position_stale', { defaultValue: 'Posición desactualizada' })}
          </Text>
        </View>
      )}
      {driverPosState.isCached && driverPosState.cachedAt && !positionIsStale && (
        <View className="items-center mt-1">
          <Text variant="caption" color="secondary" className="opacity-60">
            {t('ride.last_seen', {
              time: formatTimeAgo(driverPosState.cachedAt),
              defaultValue: 'Visto hace {{time}}',
            })}
          </Text>
        </View>
      )}
      {/* Driver not moving warning banner (4.2) */}
      {driverNotMoving && (
        <View
          className="flex-row items-center justify-center mx-4 mt-2 px-3 py-2 rounded-lg"
          style={{ backgroundColor: isDark ? '#92400E' : '#FEF3C7' }}
        >
          <Ionicons name="alert-circle-outline" size={16} color={isDark ? '#FDE68A' : '#92400E'} />
          <Text variant="caption" className="ml-1 font-semibold" style={{ color: isDark ? '#FDE68A' : '#92400E' }}>
            {t('ride.driver_not_moving', { defaultValue: 'Tu conductor no se ha movido en 5 minutos' })}
          </Text>
        </View>
      )}

      <View className="h-4" />

      {/* Status stepper */}
      <StatusStepper
        steps={RIDE_STEPS}
        currentStep={activeRide.status}
        className="mb-6"
      />

      {/* Status message */}
      <Text
        variant="h4"
        className="text-center mb-3"
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
      >
        {statusMessage[activeRide.status] ?? activeRide.status}
      </Text>

      {/* ETA Badge — U2.4: Show distance + ETA during driver_en_route */}
      {etaMinutes !== null && (
        <View className="items-center mb-4">
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <ETABadge
              label={
                activeRide.status === 'arrived_at_pickup'
                  ? t('ride.eta_driver_arrived')
                  : activeRide.status === 'in_progress'
                    ? t('ride.eta_destination', { minutes: etaMinutes })
                    : activeRide.status === 'driver_en_route' && driverPosition && activeRide.pickup_location
                      ? t('ride.distance_eta', {
                          distance: (haversineDistance(driverPosition, activeRide.pickup_location) / 1000).toFixed(1),
                          eta: etaMinutes,
                        })
                      : t('ride.eta_driver_arriving', { minutes: etaMinutes })
              }
              isCalculating={isCalculating}
              urgent={etaMinutes > 0 && etaMinutes <= 3}
              variant="light"
            />
          </Animated.View>
        </View>
      )}

      {/* Driver info */}
      {rideWithDriver?.driver_name && (
        <Animated.View className="mb-4" style={{ shadowColor: '#000', shadowOffset: { width: 0, height: -2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 5, transform: [{ translateY: slideUpAnim }] }}>
          <DriverCard
            driverName={rideWithDriver.driver_name}
            driverAvatarUrl={rideWithDriver.driver_avatar_url}
            driverRating={rideWithDriver.driver_rating}
            driverTotalRides={rideWithDriver.driver_total_rides}
            vehicleMake={rideWithDriver.vehicle_make}
            vehicleModel={rideWithDriver.vehicle_model}
            vehicleColor={rideWithDriver.vehicle_color}
            vehiclePlate={rideWithDriver.vehicle_plate}
            vehiclePhotoUrl={rideWithDriver.vehicle_photo_url}
            vehicleYear={rideWithDriver.vehicle_year}
            ridesLabel={t('ride.driver_rides_count', { count: rideWithDriver.driver_total_rides ?? 0, defaultValue: '{{count}} viajes' }).replace(/^\d+\s*/, '')}
            actions={
              <>
                <IconButton
                  icon="chatbubble-outline"
                  variant="secondary"
                  size="lg"
                  onPress={() => router.push(`/chat/${activeRide.id}`)}
                  label="Chat"
                />
                {rideWithDriver.driver_phone ? (
                  <IconButton
                    icon="call-outline"
                    variant="primary"
                    size="lg"
                    onPress={handleCall}
                    label={t('ride.call_driver', { defaultValue: 'Llamar' })}
                  />
                ) : (
                  <View style={{ alignItems: 'center', opacity: 0.5 }}>
                    <IconButton
                      icon="call-outline"
                      variant="secondary"
                      size="lg"
                      onPress={() => {}}
                      label={t('ride.driver_phone_unavailable', { defaultValue: 'Número del conductor no disponible' })}
                      disabled
                    />
                  </View>
                )}
                <IconButton
                  icon="shield-checkmark-outline"
                  variant="danger"
                  size="lg"
                  onPress={() => setSafetySheetVisible(true)}
                  label={t('ride.safety_button', { defaultValue: 'Safety' })}
                />
              </>
            }
          />
        </Animated.View>
      )}

      {/* Route info */}
      <Card variant="outlined" padding="md" className="mb-4">
        <RouteSummary
          pickupAddress={activeRide.pickup_address}
          dropoffAddress={activeRide.dropoff_address}
          pickupLabel={t('ride.pickup')}
          dropoffLabel={t('ride.dropoff')}
          waypoints={waypoints.map((wp) => ({
            address: wp.address,
            label: wp.departed_at
              ? `✅ ${t('ride.stop_n', { n: wp.sort_order, defaultValue: `Parada ${wp.sort_order}` })}`
              : wp.arrived_at
                ? `📍 ${t('ride.stop_n', { n: wp.sort_order, defaultValue: `Parada ${wp.sort_order}` })}`
                : t('ride.stop_n', { n: wp.sort_order, defaultValue: `Parada ${wp.sort_order}` }),
          }))}
        />
      </Card>

      {/* Add stop button (only during active trip, max 3 stops) */}
      {activeRide.status === 'in_progress' && waypoints.length < 3 && (
        <Button
          title={t('ride.add_stop', { defaultValue: 'Agregar parada' })}
          variant="outline"
          size="md"
          fullWidth
          onPress={() => setAddStopVisible(true)}
          className="mb-4"
        />
      )}

      {/* Fare */}
      <View className="flex-row justify-between items-center mb-6 px-2" accessible={true} accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: formatTRC(activeRide.estimated_fare_trc ?? activeRide.estimated_fare_cup) })}>
        <Text variant="bodySmall" color="secondary">{t('ride.estimated_fare')}</Text>
        <Text variant="h4" color="accent">
          {formatTRC(activeRide.estimated_fare_trc ?? activeRide.estimated_fare_cup)}
        </Text>
      </View>

      {/* Cancel button */}
      {canCancel && (
        <Button
          title={t('ride.cancel_ride')}
          variant="outline"
          size="lg"
          fullWidth
          onPress={handleCancelPress}
          loading={previewLoading}
        />
      )}

      {/* Cancel unavailable explanation (4.4) */}
      {activeRide.status === 'in_progress' && !canCancel && (
        <View className="px-4 mt-2">
          <Text variant="caption" color="secondary" className="text-center">
            {t('ride.cannot_cancel_in_progress', { defaultValue: 'No puedes cancelar un viaje en progreso' })}.{' '}
            {t('ride.contact_support', { defaultValue: 'Contacta al soporte si necesitas ayuda' })}.
          </Text>
        </View>
      )}

      {/* Add stop bottom sheet */}
      <BottomSheet visible={addStopVisible} onClose={() => setAddStopVisible(false)}>
        <Text variant="h4" className="mb-3">
          {t('ride.add_stop', { defaultValue: 'Agregar parada' })}
        </Text>
        <AddressSearchInput
          placeholder={t('ride.search_address', { defaultValue: 'Buscar dirección...' })}
          onSelect={handleAddStop}
        />
        {addingStop && (
          <Text variant="caption" color="secondary" className="mt-2 text-center">
            {t('ride.adding_stop', { defaultValue: 'Agregando parada...' })}
          </Text>
        )}
      </BottomSheet>

      {/* Cancel ride bottom sheet */}
      <CancelRideSheet
        visible={cancelSheetVisible}
        onClose={() => setCancelSheetVisible(false)}
        onConfirm={handleCancelConfirm}
        penaltyAmount={penaltyPreview.penaltyAmount}
        cancelCount24h={penaltyPreview.cancelCount24h}
        isLoading={isLoading}
        cancellationFee={cancellationFeePreview}
      />

      {/* Safety bottom sheet */}
      <SafetySheet
        visible={safetySheetVisible}
        onClose={() => setSafetySheetVisible(false)}
        rideId={activeRide.id}
        driverId={activeRide.driver_id}
        userId={userId!}
        emergencyContact={emergencyContact}
        driverPhone={rideWithDriver?.driver_phone ?? null}
      />
    </View>
  );
}

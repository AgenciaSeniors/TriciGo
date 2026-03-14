import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Pressable, Linking, Alert } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { formatCUP, formatTRC, generateReceiptHTML, triggerHaptic } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { incidentService, walletService } from '@tricigo/api';
import { useDriverRideStore } from '@/stores/ride.store';
import { useDriverRideActions } from '@/hooks/useDriverRide';
import { useRoutePolyline } from '@/hooks/useRoutePolyline';
import { RideMapView } from '@/components/RideMapView';
import { useDriverStore } from '@/stores/driver.store';
import { openNavigation } from '@/utils/navigation';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { useDriverETA } from '@/hooks/useDriverETA';
import { ETABadge } from '@tricigo/ui/ETABadge';
import { RiderRatingSheet } from './RiderRatingSheet';
import { rideService, getSupabaseClient } from '@tricigo/api';
import type { RideStatus, RideWithRider } from '@tricigo/types';

function useTripSteps() {
  const { t } = useTranslation('driver');
  return [
    { key: 'accepted', label: t('trip.step_accepted', { defaultValue: 'Aceptado' }) },
    { key: 'driver_en_route', label: t('trip.step_en_route', { defaultValue: 'En camino' }) },
    { key: 'arrived_at_pickup', label: t('trip.step_arrived', { defaultValue: 'Llegué' }) },
    { key: 'in_progress', label: t('trip.step_in_progress', { defaultValue: 'En viaje' }) },
    { key: 'completed', label: t('trip.step_completed', { defaultValue: 'Listo' }) },
  ];
}

function useActionLabels(): Partial<Record<RideStatus, string>> {
  const { t } = useTranslation('driver');
  return {
    accepted: t('trip.action_en_route', { defaultValue: 'En camino al pasajero' }),
    driver_en_route: t('trip.action_arrived', { defaultValue: 'Llegué al punto de recogida' }),
    arrived_at_pickup: t('trip.action_start', { defaultValue: 'Iniciar viaje' }),
    in_progress: t('trip.action_finish', { defaultValue: 'Finalizar viaje' }),
  };
}

export function DriverTripView() {
  const { t } = useTranslation('driver');
  const { isTablet } = useResponsive();
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const driverProfile = useDriverStore((s) => s.profile);
  const { advanceStatus, cancelTrip, clearCompletedTrip } = useDriverRideActions();
  const [waypoints, setWaypoints] = useState<Array<{ id: string; address: string; sort_order: number; latitude: number; longitude: number; arrived_at?: string | null; departed_at?: string | null }>>([]);
  const [waypointLoading, setWaypointLoading] = useState<string | null>(null);
  const lastAdvancePressRef = useRef(0);

  // Fetch waypoints + subscribe to inserts AND updates
  useEffect(() => {
    if (!activeTrip) return;
    rideService.getRideWaypoints(activeTrip.id)
      .then((wps) => setWaypoints(wps))
      .catch(() => {});

    const channel = rideService.subscribeToWaypoints(
      activeTrip.id,
      (newWp) => {
        setWaypoints((prev) => [...prev, newWp]);
        Alert.alert('', t('trip.new_stop_added', { defaultValue: 'El pasajero agregó una parada' }));
      },
      (updatedWp) => {
        setWaypoints((prev) =>
          prev.map((wp) => (wp.id === updatedWp.id ? { ...wp, ...updatedWp } : wp)),
        );
      },
    );

    return () => {
      const supabase = getSupabaseClient();
      supabase.removeChannel(channel);
    };
  }, [activeTrip?.id]);

  // Next incomplete waypoint (not yet departed)
  const nextWaypoint = waypoints.find((wp) => !wp.departed_at);
  const isAtWaypoint = nextWaypoint?.arrived_at && !nextWaypoint?.departed_at;

  const handleArriveAtWaypoint = async () => {
    if (!nextWaypoint) return;
    setWaypointLoading(nextWaypoint.id);
    try {
      await rideService.arriveAtWaypoint(nextWaypoint.id);
      setWaypoints((prev) =>
        prev.map((wp) => (wp.id === nextWaypoint.id ? { ...wp, arrived_at: new Date().toISOString() } : wp)),
      );
      triggerHaptic('light');
    } catch {
      Alert.alert('', t('trip.status_update_failed'));
    } finally {
      setWaypointLoading(null);
    }
  };

  const handleDepartFromWaypoint = async () => {
    if (!nextWaypoint) return;
    setWaypointLoading(nextWaypoint.id);
    try {
      await rideService.departFromWaypoint(nextWaypoint.id);
      setWaypoints((prev) =>
        prev.map((wp) => (wp.id === nextWaypoint.id ? { ...wp, departed_at: new Date().toISOString() } : wp)),
      );
      triggerHaptic('light');
    } catch {
      Alert.alert('', t('trip.status_update_failed'));
    } finally {
      setWaypointLoading(null);
    }
  };
  const debouncedAdvanceStatus = useCallback(() => {
    const now = Date.now();
    if (now - lastAdvancePressRef.current < 1000) return;
    lastAdvancePressRef.current = now;
    triggerHaptic('light');
    advanceStatus();
  }, [advanceStatus]);
  const TRIP_STEPS = useTripSteps();
  const ACTION_LABELS = useActionLabels();
  const routeCoordinates = useRoutePolyline(
    activeTrip?.pickup_location ?? null,
    activeTrip?.dropoff_location ?? null,
  );
  const { etaMinutes, isCalculating } = useDriverETA({
    pickupLocation: activeTrip?.pickup_location ?? null,
    dropoffLocation: activeTrip?.dropoff_location ?? null,
    rideStatus: activeTrip?.status ?? null,
  });

  if (!activeTrip) return null;

  // Completed state
  if (activeTrip.status === 'completed') {
    return <TripCompleteView />;
  }

  const canCancel =
    activeTrip.status === 'accepted' ||
    activeTrip.status === 'driver_en_route' ||
    activeTrip.status === 'arrived_at_pickup';

  const actionLabel = ACTION_LABELS[activeTrip.status];

  // Navigation target: pickup when heading to passenger, then next waypoint, then dropoff
  const navTarget =
    activeTrip.status === 'accepted' || activeTrip.status === 'driver_en_route'
      ? activeTrip.pickup_location
      : nextWaypoint && !nextWaypoint.arrived_at
        ? { latitude: nextWaypoint.latitude, longitude: nextWaypoint.longitude }
        : activeTrip.dropoff_location;

  const handleSOS = () => {
    Alert.alert(
      t('trip.sos_title'),
      t('trip.sos_body'),
      [
        { text: t('trip.sos_cancel'), style: 'cancel' },
        {
          text: t('trip.sos_call_emergency'),
          style: 'destructive',
          onPress: async () => {
            if (driverProfile?.user_id) {
              incidentService.createSOSReport({
                ride_id: activeTrip.id,
                reported_by: driverProfile.user_id,
                against_user_id: activeTrip.customer_id,
                description: 'SOS activado por conductor durante viaje',
              }).catch(() => { /* best-effort: SOS report, phone call is primary */ });
            }
            Linking.openURL('tel:106');
          },
        },
      ],
    );
  };

  const handleCancel = () => {
    Alert.alert(
      t('trip.cancel_title'),
      t('trip.cancel_body'),
      [
        { text: t('trip.sos_cancel'), style: 'cancel' },
        {
          text: t('trip.cancel_confirm'),
          style: 'destructive',
          onPress: () => cancelTrip('Cancelado por el conductor'),
        },
      ],
    );
  };

  return (
    <View className="flex-1 pt-4">
      {/* Chained ride banner */}
      {activeTrip.next_ride_id && (
        <View className="bg-info px-4 py-3 rounded-xl mb-3 flex-row items-center" accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Ionicons name="link-outline" size={18} color="white" />
          <Text variant="bodySmall" color="inverse" className="ml-2 flex-1">
            {t('trip.next_ride_queued', { defaultValue: 'Proximo viaje asignado' })}
          </Text>
        </View>
      )}

      {/* Map with route polyline */}
      <RideMapView
        pickupLocation={activeTrip.pickup_location}
        dropoffLocation={activeTrip.dropoff_location}
        routeCoordinates={routeCoordinates}
        height={isTablet ? 300 : 180}
      />
      <View className="h-3" />

      {/* Status stepper */}
      <StatusStepper
        steps={TRIP_STEPS}
        currentStep={activeTrip.status}
        variant="dark"
        className="mb-6"
      />

      {/* ETA Badge */}
      {etaMinutes !== null && (
        <View className="items-center mb-3">
          <ETABadge
            label={
              activeTrip.status === 'arrived_at_pickup'
                ? t('trip.eta_driver_arrived')
                : activeTrip.status === 'in_progress'
                  ? t('trip.eta_to_destination', { minutes: etaMinutes })
                  : t('trip.eta_driver_to_pickup', { minutes: etaMinutes })
            }
            isCalculating={isCalculating}
            urgent={etaMinutes > 0 && etaMinutes <= 3}
            variant="dark"
          />
        </View>
      )}

      {/* Rider preferences */}
      {activeTrip.rider_preferences && Object.values(activeTrip.rider_preferences).some(Boolean) && (
        <View className="flex-row flex-wrap gap-1.5 mb-3 px-1">
          <Ionicons name="options-outline" size={14} color="#9CA3AF" />
          {activeTrip.rider_preferences.quiet_mode && (
            <View className="flex-row items-center bg-neutral-800 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="volume-mute" size={12} color="#FFA726" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_quiet', { defaultValue: 'Silencio' })}</Text>
            </View>
          )}
          {activeTrip.rider_preferences.temperature === 'cool' && (
            <View className="flex-row items-center bg-neutral-800 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="snow" size={12} color="#42A5F5" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_cool', { defaultValue: 'AC fresco' })}</Text>
            </View>
          )}
          {activeTrip.rider_preferences.temperature === 'warm' && (
            <View className="flex-row items-center bg-neutral-800 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="sunny" size={12} color="#FFA726" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_warm', { defaultValue: 'Cálido' })}</Text>
            </View>
          )}
          {activeTrip.rider_preferences.conversation_ok && (
            <View className="flex-row items-center bg-neutral-800 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="chatbubbles" size={12} color="#66BB6A" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_conversation', { defaultValue: 'Conversación' })}</Text>
            </View>
          )}
          {activeTrip.rider_preferences.luggage_trunk && (
            <View className="flex-row items-center bg-neutral-800 px-2.5 py-1 rounded-full gap-1">
              <Ionicons name="briefcase" size={12} color="#AB47BC" />
              <Text variant="caption" color="inverse" className="text-xs">{t('ride.pref_trunk', { defaultValue: 'Maletero' })}</Text>
            </View>
          )}
        </View>
      )}

      {/* Route info */}
      <Card variant="filled" padding="md" className="bg-neutral-800 mb-4">
        <View className="flex-row items-start mb-3">
          <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="inverse" className="opacity-50">
              {t('trip.pickup_address')}
            </Text>
            <Text variant="bodySmall" color="inverse">
              {activeTrip.pickup_address}
            </Text>
          </View>
        </View>
        {waypoints.map((wp) => (
          <View key={wp.id} className="flex-row items-start mb-3">
            <View className={`w-2.5 h-2.5 rounded-full mt-1 mr-3 ml-[1px] ${wp.departed_at ? 'bg-success' : wp.arrived_at ? 'bg-warning' : 'bg-primary-400'}`} />
            <View className="flex-1">
              <View className="flex-row items-center gap-2">
                <Text variant="caption" color="accent" className="opacity-70">
                  {t('trip.waypoint_n', { n: wp.sort_order, defaultValue: `Parada ${wp.sort_order}` })}
                </Text>
                {wp.departed_at && (
                  <Text variant="caption" color="inverse" className="opacity-40">✅</Text>
                )}
                {wp.arrived_at && !wp.departed_at && (
                  <Text variant="caption" color="inverse" className="opacity-40">📍</Text>
                )}
              </View>
              <Text variant="bodySmall" color="inverse">
                {wp.address}
              </Text>
            </View>
          </View>
        ))}
        <View className="flex-row items-start">
          <View className="w-3 h-3 rounded-full bg-neutral-400 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="inverse" className="opacity-50">
              {t('trip.dropoff_address')}
            </Text>
            <Text variant="bodySmall" color="inverse">
              {activeTrip.dropoff_address}
            </Text>
          </View>
        </View>
      </Card>

      {/* Navigate + Chat + SOS buttons */}
      <View className="flex-row justify-center gap-3 mb-4">
        {navTarget && (
          <Pressable
            className="bg-info px-5 py-3 rounded-full flex-row items-center"
            onPress={() => openNavigation(navTarget.latitude, navTarget.longitude)}
            accessibilityRole="button"
            accessibilityLabel={t('trip.navigate', { defaultValue: 'Navegar' })}
          >
            <View className="flex-row items-center gap-2">
              <Ionicons name="navigate-outline" size={18} color="white" />
              <Text variant="body" color="inverse">{t('trip.navigate', { defaultValue: 'Navegar' })}</Text>
            </View>
          </Pressable>
        )}
        <Pressable
          className="bg-neutral-700 px-5 py-3 rounded-full flex-row items-center"
          onPress={() => router.push(`/chat/${activeTrip.id}`)}
          accessibilityRole="button"
          accessibilityLabel={t('chat.title', { defaultValue: 'Chat' })}
        >
          <View className="flex-row items-center gap-2">
            <Ionicons name="chatbubble-outline" size={18} color="white" />
            <Text variant="body" color="inverse">{t('chat.title', { defaultValue: 'Chat' })}</Text>
          </View>
        </Pressable>
        <Pressable
          className="bg-error w-12 h-12 rounded-full items-center justify-center"
          onPress={handleSOS}
          accessibilityRole="button"
          accessibilityLabel="SOS"
          accessibilityHint={t('trip.sos_body')}
        >
          <Text variant="caption" color="inverse" className="font-bold">SOS</Text>
        </Pressable>
      </View>

      {/* Fare */}
      <View className="flex-row justify-between items-center mb-6 px-2" accessible={true} accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: formatCUP(activeTrip.estimated_fare_cup) })}>
        <Text variant="bodySmall" color="inverse" className="opacity-50">
          {t('trip.earned', { defaultValue: 'Tarifa estimada' })}
        </Text>
        <View className="items-end">
          <Text variant="h4" color="accent">
            {formatCUP(activeTrip.estimated_fare_cup)}
          </Text>
          {activeTrip.estimated_fare_trc != null && (
            <Text variant="caption" color="inverse" className="opacity-50">
              ~{formatTRC(activeTrip.estimated_fare_trc)}
            </Text>
          )}
        </View>
      </View>

      {/* Waypoint action buttons (arrive / depart) */}
      {activeTrip.status === 'in_progress' && nextWaypoint && !isAtWaypoint && (
        <Button
          title={t('trip.arrive_at_stop', { n: nextWaypoint.sort_order, defaultValue: `Llegué a Parada ${nextWaypoint.sort_order}` })}
          variant="outline"
          size="lg"
          fullWidth
          onPress={handleArriveAtWaypoint}
          loading={waypointLoading === nextWaypoint.id}
          className="mb-3"
        />
      )}
      {activeTrip.status === 'in_progress' && isAtWaypoint && nextWaypoint && (
        <Button
          title={t('trip.depart_from_stop', { n: nextWaypoint.sort_order, defaultValue: `Continuar desde Parada ${nextWaypoint.sort_order}` })}
          size="lg"
          fullWidth
          onPress={handleDepartFromWaypoint}
          loading={waypointLoading === nextWaypoint.id}
          className="mb-3"
        />
      )}

      {/* Main action button (hide "Finalizar" while there are pending waypoints) */}
      {actionLabel && !(activeTrip.status === 'in_progress' && nextWaypoint) && (
        <Button
          title={actionLabel}
          size="lg"
          fullWidth
          onPress={debouncedAdvanceStatus}
          className="mb-3"
        />
      )}

      {/* Cancel */}
      {canCancel && (
        <Button
          title={t('trip.cancel_trip')}
          variant="outline"
          size="lg"
          fullWidth
          onPress={handleCancel}
        />
      )}
    </View>
  );
}

function TripCompleteView() {
  const { t } = useTranslation('driver');
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const driverProfile = useDriverStore((s) => s.profile);
  const { clearCompletedTrip } = useDriverRideActions();
  const [commissionRate, setCommissionRate] = useState(0.15);
  const [rideWithRider, setRideWithRider] = useState<RideWithRider | null>(null);
  const [showRating, setShowRating] = useState(true);

  useEffect(() => {
    walletService.getConfigValue('commission_rate')
      .then((val) => {
        if (val) {
          const parsed = parseFloat(String(val).replace(/"/g, ''));
          if (!isNaN(parsed) && parsed > 0 && parsed < 1) setCommissionRate(parsed);
        }
      })
      .catch(() => { /* best-effort: use default 0.15 */ });
  }, []);

  // Fetch rider info for rating
  useEffect(() => {
    if (!activeTrip) return;
    rideService.getRideWithRider(activeTrip.id)
      .then(setRideWithRider)
      .catch(() => { /* best-effort: rating still works without rider info */ });
  }, [activeTrip?.id]);

  if (!activeTrip) return null;

  const fare = activeTrip.final_fare_cup ?? activeTrip.estimated_fare_cup;
  const commissionAmount = Math.round(fare * commissionRate);
  const netEarnings = fare - commissionAmount;
  const isCash = activeTrip.payment_method === 'cash' || activeTrip.payment_method === 'mixed';

  const handleDownloadReceipt = async () => {
    if (!activeTrip) return;
    const html = generateReceiptHTML({
      rideId: activeTrip.id,
      date: activeTrip.completed_at ?? activeTrip.created_at,
      pickupAddress: activeTrip.pickup_address ?? '',
      dropoffAddress: activeTrip.dropoff_address ?? '',
      driverName: null,
      vehiclePlate: null,
      serviceType: activeTrip.service_type,
      paymentMethod: activeTrip.payment_method,
      fareCup: activeTrip.final_fare_cup ?? activeTrip.estimated_fare_cup,
      fareTrc: activeTrip.final_fare_trc ?? activeTrip.estimated_fare_trc ?? null,
      distanceM: activeTrip.actual_distance_m ?? activeTrip.estimated_distance_m ?? 0,
      durationS: activeTrip.actual_duration_s ?? activeTrip.estimated_duration_s ?? 0,
      surgeMultiplier: activeTrip.surge_multiplier ?? 1,
      discountCup: activeTrip.discount_amount_cup ?? 0,
    });
    try {
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Recibo TriciGo' });
      }
    } catch (err) {
      console.error('Receipt generation failed:', err);
    }
  };

  return (
    <View className="flex-1 pt-8 items-center">
      <View className="w-20 h-20 rounded-full bg-success items-center justify-center mb-4">
        <Ionicons name="checkmark" size={40} color="white" />
      </View>

      <Text variant="h3" color="inverse" className="mb-2">
        {t('trip.trip_completed')}
      </Text>

      <Text variant="h2" color="accent" className="mb-2">
        {formatCUP(fare)}
      </Text>

      {/* Trip stats */}
      {activeTrip.actual_distance_m != null && (
        <View className="flex-row gap-4 mb-4" accessible={true} accessibilityLabel={`${t('a11y.stat_distance', { ns: 'common', value: `${(activeTrip.actual_distance_m / 1000).toFixed(1)} km` })}, ${t('a11y.stat_duration', { ns: 'common', value: `${Math.round((activeTrip.actual_duration_s ?? 0) / 60)} min` })}`}>
          <Text variant="caption" color="inverse" className="opacity-50">
            {(activeTrip.actual_distance_m / 1000).toFixed(1)} km
          </Text>
          <Text variant="caption" color="inverse" className="opacity-50">
            {Math.round((activeTrip.actual_duration_s ?? 0) / 60)} min
          </Text>
        </View>
      )}

      {/* Commission breakdown */}
      <Card variant="filled" padding="md" className="w-full bg-neutral-800 mb-6">
        <View className="flex-row justify-between mb-2">
          <Text variant="bodySmall" color="inverse" className="opacity-60">
            {t('trip.total_fare', { defaultValue: 'Tarifa total' })}
          </Text>
          <Text variant="bodySmall" color="inverse">
            {formatCUP(fare)}
          </Text>
        </View>
        <View className="flex-row justify-between mb-2">
          <Text variant="bodySmall" color="inverse" className="opacity-60">
            {t('trip.platform_commission', { defaultValue: 'Comisión plataforma (15%)' })}
          </Text>
          <Text variant="bodySmall" className="text-red-400">
            -{formatCUP(commissionAmount)}
          </Text>
        </View>
        <View className="h-px bg-neutral-600 my-2" />
        <View className="flex-row justify-between">
          <Text variant="body" color="inverse" className="font-bold">
            {isCash ? t('trip.collect_cash', { defaultValue: 'Cobras en efectivo' }) : t('trip.net_earnings', { defaultValue: 'Ganancia neta' })}
          </Text>
          <Text variant="body" color="accent" className="font-bold">
            {formatCUP(netEarnings)}
          </Text>
        </View>
        {isCash && (
          <Text variant="caption" color="inverse" className="opacity-40 mt-1">
            {t('trip.commission_deducted', { defaultValue: 'La comisión se descuenta de tu saldo' })}
          </Text>
        )}
      </Card>

      {/* Tip received */}
      {(activeTrip.tip_amount ?? 0) > 0 && (
        <Card variant="filled" padding="md" className="w-full bg-neutral-800 mb-6">
          <View className="flex-row justify-between items-center" accessibilityRole="alert" accessibilityLiveRegion="polite">
            <View className="flex-row items-center gap-1">
              <Ionicons name="gift-outline" size={16} color="white" />
              <Text variant="body" color="inverse">{t('trip.tip_received', { amount: formatTRC(activeTrip.tip_amount!), defaultValue: '¡Recibiste una propina!' })}</Text>
            </View>
            <Text variant="body" color="accent" className="font-bold">
              +{formatTRC(activeTrip.tip_amount!)}
            </Text>
          </View>
        </Card>
      )}

      {/* Surge indicator */}
      {(activeTrip.surge_multiplier ?? 1) > 1 && (
        <Text variant="caption" color="inverse" className="opacity-50 text-center mb-4">
          {t('trip.surge_active', { multiplier: activeTrip.surge_multiplier, defaultValue: `Tarifa dinámica ${activeTrip.surge_multiplier}x activa` })}
        </Text>
      )}

      <Button
        title={t('trip.download_receipt', { defaultValue: 'Descargar recibo' })}
        variant="outline"
        size="lg"
        fullWidth
        onPress={handleDownloadReceipt}
        className="mb-3"
      />

      {/* Rider rating */}
      {showRating && rideWithRider && driverProfile?.user_id && (
        <View className="w-full mb-3">
          <RiderRatingSheet
            rideId={activeTrip.id}
            reviewerId={driverProfile.user_id}
            riderId={rideWithRider.customer_id}
            riderName={rideWithRider.rider_name}
            riderAvatarUrl={rideWithRider.rider_avatar_url}
            onComplete={clearCompletedTrip}
            onSkip={() => setShowRating(false)}
          />
        </View>
      )}

      <Button
        title={t('trip.back_to_home', { defaultValue: 'Volver al inicio' })}
        size="lg"
        fullWidth
        onPress={clearCompletedTrip}
      />
    </View>
  );
}

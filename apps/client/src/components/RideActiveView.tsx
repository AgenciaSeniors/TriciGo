import React, { useState, useCallback, useEffect } from 'react';
import { View, Pressable, Linking, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { formatTRC } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
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

  // Waypoints state
  const [waypoints, setWaypoints] = useState<Array<{ id: string; address: string; sort_order: number; latitude: number; longitude: number; arrived_at?: string | null; departed_at?: string | null }>>([]);
  const [addStopVisible, setAddStopVisible] = useState(false);
  const [addingStop, setAddingStop] = useState(false);

  // Fetch existing waypoints + subscribe to inserts AND updates (driver arrive/depart)
  useEffect(() => {
    if (!activeRide) return;
    rideService.getRideWaypoints(activeRide.id)
      .then((wps) => setWaypoints(wps))
      .catch(() => {});

    const channel = rideService.subscribeToWaypoints(
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
      const supabase = getSupabaseClient();
      supabase.removeChannel(channel);
    };
  }, [activeRide?.id]);

  // Subscribe to real-time split changes (invitations, acceptances, payments)
  useEffect(() => {
    if (!activeRide?.id || !activeRide.is_split) return;

    // Fetch existing splits
    rideService.getSplitsForRide(activeRide.id)
      .then((existingSplits) => setSplits(existingSplits))
      .catch(() => {});

    const channel = rideService.subscribeToSplits(
      activeRide.id,
      (newSplit) => addSplit(newSplit),
      (updatedSplit) => updateSplit(updatedSplit),
    );

    return () => {
      const supabase = getSupabaseClient();
      supabase.removeChannel(channel);
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
    } catch (err: any) {
      if (err?.message === 'MAX_WAYPOINTS_REACHED') {
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
              }).catch(() => { /* best-effort: SOS report, phone call is primary */ });
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
      {/* Live map with route polyline */}
      <View style={{ position: 'relative' }}>
        <RideMapView
          pickupLocation={activeRide.pickup_location}
          dropoffLocation={activeRide.dropoff_location}
          driverLocation={driverPosition}
          driverMarkerOpacity={driverPosState.isCached ? 0.6 : 1}
          routeCoordinates={routeCoordinates}
          height={200}
        />
        {!driverPosition && (
          <View
            className="absolute inset-0 items-center justify-center bg-neutral-100/80"
            style={{ borderRadius: 12 }}
          >
            <ActivityIndicator size="small" color="#F97316" />
            <Text variant="caption" color="secondary" className="mt-2">
              {t('ride.loading_map', { defaultValue: 'Cargando mapa...' })}
            </Text>
          </View>
        )}
      </View>
      {driverPosState.isCached && driverPosState.cachedAt && (
        <View className="items-center mt-1">
          <Text variant="caption" color="secondary" className="opacity-60">
            {t('ride.last_seen', {
              time: formatTimeAgo(driverPosState.cachedAt),
              defaultValue: 'Visto hace {{time}}',
            })}
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

      {/* ETA Badge */}
      {etaMinutes !== null && (
        <View className="items-center mb-4">
          <ETABadge
            label={
              activeRide.status === 'arrived_at_pickup'
                ? t('ride.eta_driver_arrived')
                : activeRide.status === 'in_progress'
                  ? t('ride.eta_destination', { minutes: etaMinutes })
                  : t('ride.eta_driver_arriving', { minutes: etaMinutes })
            }
            isCalculating={isCalculating}
            urgent={etaMinutes > 0 && etaMinutes <= 3}
            variant="light"
          />
        </View>
      )}

      {/* Driver info */}
      {rideWithDriver?.driver_name && (
        <View className="mb-4">
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
                {rideWithDriver.driver_phone && (
                  <IconButton
                    icon="call-outline"
                    variant="primary"
                    size="lg"
                    onPress={handleCall}
                    label={t('ride.call_driver', { defaultValue: 'Llamar' })}
                  />
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
        </View>
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
      />
    </View>
  );
}

import React from 'react';
import { View, Pressable, Linking, Alert } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { incidentService } from '@tricigo/api';
import { useDriverRideStore } from '@/stores/ride.store';
import { useDriverRideActions } from '@/hooks/useDriverRide';
import { RideMapView } from '@/components/RideMapView';
import { useDriverStore } from '@/stores/driver.store';
import type { RideStatus } from '@tricigo/types';

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
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const driverProfile = useDriverStore((s) => s.profile);
  const { advanceStatus, cancelTrip, clearCompletedTrip } = useDriverRideActions();
  const TRIP_STEPS = useTripSteps();
  const ACTION_LABELS = useActionLabels();

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

  const handleSOS = () => {
    Alert.alert(
      'SOS - Emergencia',
      '¿Estás en peligro? Se registrará un reporte de emergencia.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Llamar emergencia',
          style: 'destructive',
          onPress: async () => {
            if (driverProfile?.user_id) {
              incidentService.createSOSReport({
                ride_id: activeTrip.id,
                reported_by: driverProfile.user_id,
                against_user_id: activeTrip.customer_id,
                description: 'SOS activado por conductor durante viaje',
              }).catch(() => {});
            }
            Linking.openURL('tel:106');
          },
        },
      ],
    );
  };

  const handleCancel = () => {
    Alert.alert(
      t('trip.cancel_trip'),
      '',
      [
        { text: 'No', style: 'cancel' },
        {
          text: t('trip.cancel_trip'),
          style: 'destructive',
          onPress: () => cancelTrip('Cancelado por el conductor'),
        },
      ],
    );
  };

  return (
    <View className="flex-1 pt-4">
      {/* Map */}
      <RideMapView
        pickupLocation={activeTrip.pickup_location}
        dropoffLocation={activeTrip.dropoff_location}
        height={180}
      />
      <View className="h-3" />

      {/* Status stepper */}
      <StatusStepper
        steps={TRIP_STEPS}
        currentStep={activeTrip.status}
        variant="dark"
        className="mb-6"
      />

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

      {/* Chat + SOS buttons */}
      <View className="flex-row justify-center gap-3 mb-4">
        <Pressable
          className="bg-neutral-700 px-6 py-3 rounded-full flex-row items-center"
          onPress={() => router.push(`/chat/${activeTrip.id}`)}
        >
          <Text variant="body" color="inverse">💬  {t('chat.title', { defaultValue: 'Chat' })}</Text>
        </Pressable>
        <Pressable
          className="bg-red-600 w-12 h-12 rounded-full items-center justify-center"
          onPress={handleSOS}
        >
          <Text variant="caption" color="inverse" className="font-bold">SOS</Text>
        </Pressable>
      </View>

      {/* Fare */}
      <View className="flex-row justify-between items-center mb-6 px-2">
        <Text variant="bodySmall" color="inverse" className="opacity-50">
          {t('trip.earned', { defaultValue: 'Tarifa estimada' })}
        </Text>
        <Text variant="h4" color="accent">
          {formatCUP(activeTrip.estimated_fare_cup)}
        </Text>
      </View>

      {/* Main action button */}
      {actionLabel && (
        <Button
          title={actionLabel}
          size="lg"
          fullWidth
          onPress={advanceStatus}
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
  const { clearCompletedTrip } = useDriverRideActions();

  if (!activeTrip) return null;

  const fare = activeTrip.final_fare_cup ?? activeTrip.estimated_fare_cup;
  const commissionRate = 0.15;
  const commissionAmount = Math.round(fare * commissionRate);
  const netEarnings = fare - commissionAmount;
  const isCash = activeTrip.payment_method === 'cash' || activeTrip.payment_method === 'mixed';

  return (
    <View className="flex-1 pt-8 items-center">
      <View className="w-20 h-20 rounded-full bg-success items-center justify-center mb-4">
        <Text variant="h1" color="inverse">✓</Text>
      </View>

      <Text variant="h3" color="inverse" className="mb-2">
        {t('trip.trip_completed')}
      </Text>

      <Text variant="h2" color="accent" className="mb-2">
        {formatCUP(fare)}
      </Text>

      {/* Trip stats */}
      {activeTrip.actual_distance_m != null && (
        <View className="flex-row gap-4 mb-4">
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
          <View className="flex-row justify-between items-center">
            <Text variant="body" color="inverse">🎉 {t('trip.tip_received', { amount: formatCUP(activeTrip.tip_amount!), defaultValue: '¡Recibiste una propina!' })}</Text>
            <Text variant="body" color="accent" className="font-bold">
              +{formatCUP(activeTrip.tip_amount!)}
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
        title={t('trip.back_to_home', { defaultValue: 'Volver al inicio' })}
        size="lg"
        fullWidth
        onPress={clearCompletedTrip}
      />
    </View>
  );
}

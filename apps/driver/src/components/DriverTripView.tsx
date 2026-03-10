import React from 'react';
import { View, Pressable, Linking, Alert } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { StatusStepper } from '@tricigo/ui/StatusStepper';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { useDriverRideStore } from '@/stores/ride.store';
import { useDriverRideActions } from '@/hooks/useDriverRide';
import type { RideStatus } from '@tricigo/types';

const TRIP_STEPS = [
  { key: 'accepted', label: 'Aceptado' },
  { key: 'driver_en_route', label: 'En camino' },
  { key: 'arrived_at_pickup', label: 'Llegué' },
  { key: 'in_progress', label: 'En viaje' },
  { key: 'completed', label: 'Listo' },
];

const ACTION_LABELS: Partial<Record<RideStatus, string>> = {
  accepted: 'En camino al pasajero',
  driver_en_route: 'Llegué al punto de recogida',
  arrived_at_pickup: 'Iniciar viaje',
  in_progress: 'Finalizar viaje',
};

export function DriverTripView() {
  const { t } = useTranslation('driver');
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const { advanceStatus, cancelTrip, clearCompletedTrip } = useDriverRideActions();

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

      {/* Chat button */}
      <View className="flex-row justify-center mb-4">
        <Pressable
          className="bg-neutral-700 px-6 py-3 rounded-full flex-row items-center"
          onPress={() => router.push(`/chat/${activeTrip.id}`)}
        >
          <Text variant="body" color="inverse">💬  {t('chat.title', { defaultValue: 'Chat' })}</Text>
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

  return (
    <View className="flex-1 pt-8 items-center">
      <View className="w-20 h-20 rounded-full bg-success items-center justify-center mb-4">
        <Text variant="h1" color="inverse">✓</Text>
      </View>

      <Text variant="h3" color="inverse" className="mb-2">
        {t('trip.trip_completed')}
      </Text>

      <Text variant="h2" color="accent" className="mb-6">
        {formatCUP(fare)}
      </Text>

      <Text variant="bodySmall" color="inverse" className="opacity-50 mb-8">
        {t('trip.earned')}
      </Text>

      <Button
        title={t('trip.back_to_home', { defaultValue: 'Volver al inicio' })}
        size="lg"
        fullWidth
        onPress={clearCompletedTrip}
      />
    </View>
  );
}

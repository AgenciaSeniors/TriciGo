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
import { useRideStore } from '@/stores/ride.store';
import { useRideActions } from '@/hooks/useRide';
import { useAuthStore } from '@/stores/auth.store';
import { RideMapView } from '@/components/RideMapView';
import { useDriverPosition } from '@/hooks/useDriverPosition';

const RIDE_STEPS = [
  { key: 'accepted', label: 'Aceptado' },
  { key: 'driver_en_route', label: 'En camino' },
  { key: 'arrived_at_pickup', label: 'En recogida' },
  { key: 'in_progress', label: 'En viaje' },
];

export function RideActiveView() {
  const { t } = useTranslation('rider');
  const activeRide = useRideStore((s) => s.activeRide);
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);
  const isLoading = useRideStore((s) => s.isLoading);
  const userId = useAuthStore((s) => s.user?.id);
  const { cancelRide } = useRideActions();
  const driverPosition = useDriverPosition(activeRide?.id ?? null);

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
      'SOS - Emergencia',
      '¿Estás en peligro? Se registrará un reporte de emergencia y se abrirá el marcador telefónico.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Llamar emergencia',
          style: 'destructive',
          onPress: async () => {
            if (userId) {
              incidentService.createSOSReport({
                ride_id: activeRide.id,
                reported_by: userId,
                against_user_id: activeRide.driver_id ?? undefined,
                description: 'SOS activado por pasajero durante viaje',
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
      t('ride.cancel_ride'),
      t('ride.cancel_confirm'),
      [
        { text: 'No', style: 'cancel' },
        {
          text: t('ride.cancel_ride'),
          style: 'destructive',
          onPress: () => cancelRide('Cancelado por el pasajero'),
        },
      ],
    );
  };

  const statusMessage: Record<string, string> = {
    accepted: t('ride.driver_assigned'),
    driver_en_route: t('ride.driver_arriving'),
    arrived_at_pickup: t('ride.driver_arrived'),
    in_progress: t('ride.in_progress'),
  };

  return (
    <View className="flex-1 pt-4">
      {/* Live map */}
      <RideMapView
        pickupLocation={activeRide.pickup_location}
        dropoffLocation={activeRide.dropoff_location}
        driverLocation={driverPosition}
        height={200}
      />
      <View className="h-4" />

      {/* Status stepper */}
      <StatusStepper
        steps={RIDE_STEPS}
        currentStep={activeRide.status}
        className="mb-6"
      />

      {/* Status message */}
      <Text variant="h4" className="text-center mb-4">
        {statusMessage[activeRide.status] ?? activeRide.status}
      </Text>

      {/* Driver info */}
      {rideWithDriver?.driver_name && (
        <Card variant="elevated" padding="md" className="mb-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-1">
              <Text variant="h4">{rideWithDriver.driver_name}</Text>
              {rideWithDriver.driver_rating && (
                <Text variant="caption" color="secondary">
                  {'★ '}{rideWithDriver.driver_rating.toFixed(1)}
                </Text>
              )}
              {rideWithDriver.vehicle_make && (
                <Text variant="bodySmall" color="secondary" className="mt-1">
                  {rideWithDriver.vehicle_make} {rideWithDriver.vehicle_model}
                  {rideWithDriver.vehicle_color ? ` · ${rideWithDriver.vehicle_color}` : ''}
                </Text>
              )}
              {rideWithDriver.vehicle_plate && (
                <Text variant="label" color="accent" className="mt-1">
                  {rideWithDriver.vehicle_plate}
                </Text>
              )}
            </View>

            <View className="flex-row gap-2">
              <Pressable
                className="bg-neutral-200 w-12 h-12 rounded-full items-center justify-center"
                onPress={() => router.push(`/chat/${activeRide.id}`)}
              >
                <Text variant="h4">💬</Text>
              </Pressable>
              {rideWithDriver.driver_phone && (
                <Pressable
                  className="bg-primary-500 w-12 h-12 rounded-full items-center justify-center"
                  onPress={handleCall}
                >
                  <Text variant="h4" color="inverse">📞</Text>
                </Pressable>
              )}
              <Pressable
                className="bg-red-600 w-12 h-12 rounded-full items-center justify-center"
                onPress={handleSOS}
              >
                <Text variant="caption" color="inverse" className="font-bold">SOS</Text>
              </Pressable>
            </View>
          </View>
        </Card>
      )}

      {/* Route info */}
      <Card variant="outlined" padding="md" className="mb-4">
        <View className="flex-row items-start mb-3">
          <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="secondary">{t('ride.pickup')}</Text>
            <Text variant="bodySmall">{activeRide.pickup_address}</Text>
          </View>
        </View>
        <View className="flex-row items-start">
          <View className="w-3 h-3 rounded-full bg-neutral-800 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="secondary">{t('ride.dropoff')}</Text>
            <Text variant="bodySmall">{activeRide.dropoff_address}</Text>
          </View>
        </View>
      </Card>

      {/* Fare */}
      <View className="flex-row justify-between items-center mb-6 px-2">
        <Text variant="bodySmall" color="secondary">{t('ride.estimated_fare')}</Text>
        <Text variant="h4" color="accent">
          {formatCUP(activeRide.estimated_fare_cup)}
        </Text>
      </View>

      {/* Cancel button */}
      {canCancel && (
        <Button
          title={t('ride.cancel_ride')}
          variant="outline"
          size="lg"
          fullWidth
          onPress={handleCancel}
          loading={isLoading}
        />
      )}
    </View>
  );
}

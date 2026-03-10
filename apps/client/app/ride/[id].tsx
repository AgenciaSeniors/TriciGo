import React, { useEffect, useState } from 'react';
import { View, Pressable, ActivityIndicator, Share } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { formatCUP } from '@tricigo/utils';
import type { RideWithDriver, RidePricingSnapshot } from '@tricigo/types';
import { RideMapView } from '@/components/RideMapView';

const STATUS_LABEL: Record<string, string> = {
  searching: 'Buscando',
  accepted: 'Aceptado',
  driver_en_route: 'En camino',
  arrived_at_pickup: 'En punto',
  in_progress: 'En progreso',
  completed: 'Completado',
  canceled: 'Cancelado',
};

export default function RideDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation('rider');

  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [pricing, setPricing] = useState<RidePricingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function load() {
      try {
        const [rideData, pricingData] = await Promise.all([
          rideService.getRideWithDriver(id),
          rideService.getPricingSnapshot(id),
        ]);
        if (!cancelled) {
          setRide(rideData);
          setPricing(pricingData);
        }
      } catch (err) {
        console.error('Error loading ride detail:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <Screen bg="white" padded>
        <View className="flex-1 items-center justify-center py-20">
          <ActivityIndicator size="large" color="#FF4D00" />
        </View>
      </Screen>
    );
  }

  if (!ride) {
    return (
      <Screen bg="white" padded>
        <View className="pt-4">
          <Pressable onPress={() => router.back()} className="mb-4">
            <Text variant="body" color="accent">{t('ride.back_button', { defaultValue: '← Volver' })}</Text>
          </Pressable>
          <Text variant="body" color="tertiary">Viaje no encontrado</Text>
        </View>
      </Screen>
    );
  }

  const fare = ride.final_fare_cup ?? ride.estimated_fare_cup;
  const isCompleted = ride.status === 'completed';

  const handleShare = () => {
    if (ride.share_token) {
      Share.share({ message: `https://tricigo.app/ride/${ride.share_token}` });
    }
  };

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4 pb-8">
        {/* Header */}
        <Pressable onPress={() => router.back()} className="mb-4">
          <Text variant="body" color="accent">{t('ride.back_button', { defaultValue: '← Volver' })}</Text>
        </Pressable>

        <View className="flex-row items-center justify-between mb-4">
          <Text variant="h3">{t('ride.ride_detail', { defaultValue: 'Detalle del viaje' })}</Text>
          <View className={`px-3 py-1 rounded-full ${isCompleted ? 'bg-green-100' : 'bg-red-100'}`}>
            <Text variant="caption" className={isCompleted ? 'text-green-700' : 'text-red-700'}>
              {STATUS_LABEL[ride.status] ?? ride.status}
            </Text>
          </View>
        </View>

        {/* Map */}
        <RideMapView
          pickupLocation={ride.pickup_location}
          dropoffLocation={ride.dropoff_location}
          height={180}
        />
        <View className="h-4" />

        {/* Route */}
        <Card variant="outlined" padding="md" className="mb-4">
          <View className="flex-row items-start mb-3">
            <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
            <View className="flex-1">
              <Text variant="caption" color="secondary">{t('ride.pickup')}</Text>
              <Text variant="bodySmall">{ride.pickup_address}</Text>
            </View>
          </View>
          <View className="flex-row items-start">
            <View className="w-3 h-3 rounded-full bg-neutral-800 mt-1 mr-3" />
            <View className="flex-1">
              <Text variant="caption" color="secondary">{t('ride.dropoff')}</Text>
              <Text variant="bodySmall">{ride.dropoff_address}</Text>
            </View>
          </View>
        </Card>

        {/* Driver info */}
        {ride.driver_name && (
          <Card variant="filled" padding="md" className="mb-4">
            <Text variant="label" className="mb-2">{t('ride.driver_info', { defaultValue: 'Conductor' })}</Text>
            <View className="flex-row items-center">
              <View className="w-10 h-10 rounded-full bg-primary-500 items-center justify-center mr-3">
                <Text variant="body" color="inverse" className="font-bold">
                  {ride.driver_name.charAt(0)}
                </Text>
              </View>
              <View className="flex-1">
                <Text variant="body" className="font-semibold">{ride.driver_name}</Text>
                {ride.driver_rating != null && (
                  <Text variant="caption" color="secondary">★ {Number(ride.driver_rating).toFixed(1)}</Text>
                )}
              </View>
              {ride.vehicle_plate && (
                <View>
                  <Text variant="caption" color="secondary">
                    {ride.vehicle_make} {ride.vehicle_model}
                  </Text>
                  <Text variant="caption" className="font-semibold">{ride.vehicle_plate}</Text>
                </View>
              )}
            </View>
          </Card>
        )}

        {/* Fare breakdown */}
        <Card variant="elevated" padding="lg" className="mb-4">
          <Text variant="h4" className="mb-3">{t('ride.fare_breakdown')}</Text>

          {ride.final_fare_cup != null && ride.final_fare_cup !== ride.estimated_fare_cup && (
            <View className="flex-row justify-between mb-2">
              <Text variant="bodySmall" color="secondary">{t('ride.estimated_fare')}</Text>
              <Text variant="bodySmall" color="secondary" className="line-through">
                {formatCUP(ride.estimated_fare_cup)}
              </Text>
            </View>
          )}

          {pricing && (
            <>
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="secondary">{t('ride.base_fare')}</Text>
                <Text variant="caption">{formatCUP(pricing.base_fare)}</Text>
              </View>
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="secondary">{t('ride.distance_charge')}</Text>
                <Text variant="caption">{formatCUP(Math.round(pricing.per_km_rate * pricing.distance_m / 1000))}</Text>
              </View>
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="secondary">{t('ride.time_charge')}</Text>
                <Text variant="caption">{formatCUP(Math.round(pricing.per_minute_rate * pricing.duration_s / 60))}</Text>
              </View>
            </>
          )}

          {ride.discount_amount_cup > 0 && (
            <View className="flex-row justify-between mb-2">
              <Text variant="bodySmall" className="text-green-600">{t('ride.discount')}</Text>
              <Text variant="bodySmall" className="text-green-600">-{formatCUP(ride.discount_amount_cup)}</Text>
            </View>
          )}

          <View className="h-px bg-neutral-200 my-2" />
          <View className="flex-row justify-between">
            <Text variant="h4">{ride.final_fare_cup != null ? t('ride.final_fare') : t('ride.estimated_fare')}</Text>
            <Text variant="h3" color="accent">{formatCUP(fare)}</Text>
          </View>
        </Card>

        {/* Trip stats */}
        {(ride.actual_distance_m != null || ride.estimated_distance_m > 0) && (
          <Card variant="outlined" padding="md" className="mb-4">
            <Text variant="label" className="mb-2">{t('ride.trip_stats', { defaultValue: 'Estadísticas' })}</Text>
            <View className="flex-row gap-6">
              <View>
                <Text variant="caption" color="secondary">{t('ride.distance')}</Text>
                <Text variant="body" className="font-semibold">
                  {((ride.actual_distance_m ?? ride.estimated_distance_m) / 1000).toFixed(1)} km
                </Text>
              </View>
              <View>
                <Text variant="caption" color="secondary">{t('ride.eta')}</Text>
                <Text variant="body" className="font-semibold">
                  {Math.round((ride.actual_duration_s ?? ride.estimated_duration_s) / 60)} min
                </Text>
              </View>
              <View>
                <Text variant="caption" color="secondary">{t('ride.payment_method')}</Text>
                <Text variant="body" className="font-semibold">
                  {ride.payment_method === 'cash' ? t('payment.cash') : t('payment.tricicoin')}
                </Text>
              </View>
            </View>
          </Card>
        )}

        {/* Timestamps */}
        <Card variant="outlined" padding="md" className="mb-6">
          <Text variant="label" className="mb-2">{t('ride.timestamps', { defaultValue: 'Tiempos' })}</Text>
          <View className="flex-row justify-between mb-1">
            <Text variant="caption" color="secondary">Creado</Text>
            <Text variant="caption">{new Date(ride.created_at).toLocaleString('es-CU')}</Text>
          </View>
          {ride.accepted_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">Aceptado</Text>
              <Text variant="caption">{new Date(ride.accepted_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.pickup_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">Recogida</Text>
              <Text variant="caption">{new Date(ride.pickup_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.completed_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">Completado</Text>
              <Text variant="caption">{new Date(ride.completed_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.canceled_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">Cancelado</Text>
              <Text variant="caption">{new Date(ride.canceled_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
        </Card>

        {/* Share button */}
        {ride.share_token && (
          <Button
            title={t('ride.share_ride')}
            variant="outline"
            size="lg"
            fullWidth
            onPress={handleShare}
          />
        )}
      </View>
    </Screen>
  );
}

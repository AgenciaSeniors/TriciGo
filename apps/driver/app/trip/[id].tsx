import React, { useEffect, useState } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { formatCUP } from '@tricigo/utils';
import type { RideWithDriver, RidePricingSnapshot } from '@tricigo/types';
import { RideMapView } from '@/components/RideMapView';

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation('driver');

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
        console.error('Error loading trip detail:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <Screen bg="dark" statusBarStyle="light-content" padded>
        <View className="flex-1 items-center justify-center py-20">
          <ActivityIndicator size="large" color="#FF4D00" />
        </View>
      </Screen>
    );
  }

  if (!ride) {
    return (
      <Screen bg="dark" statusBarStyle="light-content" padded>
        <View className="pt-4">
          <Pressable onPress={() => router.back()} className="mb-4">
            <Text variant="body" color="accent">← {t('trip.back_to_home', { defaultValue: 'Volver' })}</Text>
          </Pressable>
          <Text variant="body" color="inverse" className="opacity-50">{t('trip.not_found')}</Text>
        </View>
      </Screen>
    );
  }

  const fare = ride.final_fare_cup ?? ride.estimated_fare_cup;
  const isCompleted = ride.status === 'completed';
  const commissionRate = pricing?.commission_rate ?? 0.15;
  const commissionAmount = Math.round(fare * commissionRate);
  const netEarnings = fare - commissionAmount;
  const isCash = ride.payment_method === 'cash' || ride.payment_method === 'mixed';

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4 pb-8">
        {/* Header */}
        <Pressable onPress={() => router.back()} className="mb-4">
          <Text variant="body" color="accent">← {t('trip.back_to_home', { defaultValue: 'Volver' })}</Text>
        </Pressable>

        <View className="flex-row items-center justify-between mb-4">
          <Text variant="h3" color="inverse">{t('trip.trip_detail', { defaultValue: 'Detalle del viaje' })}</Text>
          <View className={`px-3 py-1 rounded-full ${isCompleted ? 'bg-green-900' : 'bg-red-900'}`}>
            <Text variant="caption" className={isCompleted ? 'text-green-400' : 'text-red-400'}>
              {isCompleted ? t('trips_history.completed') : t('trips_history.canceled')}
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
        <Card variant="filled" padding="md" className="bg-neutral-800 mb-4">
          <View className="flex-row items-start mb-3">
            <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
            <View className="flex-1">
              <Text variant="caption" color="inverse" className="opacity-50">{t('trip.pickup_address')}</Text>
              <Text variant="bodySmall" color="inverse">{ride.pickup_address}</Text>
            </View>
          </View>
          <View className="flex-row items-start">
            <View className="w-3 h-3 rounded-full bg-neutral-400 mt-1 mr-3" />
            <View className="flex-1">
              <Text variant="caption" color="inverse" className="opacity-50">{t('trip.dropoff_address')}</Text>
              <Text variant="bodySmall" color="inverse">{ride.dropoff_address}</Text>
            </View>
          </View>
        </Card>

        {/* Fare + Commission */}
        <Card variant="filled" padding="lg" className="bg-neutral-800 mb-4">
          <Text variant="h2" color="accent" className="text-center mb-4">{formatCUP(fare)}</Text>

          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" color="inverse" className="opacity-60">
              {t('trip.total_fare', { defaultValue: 'Tarifa total' })}
            </Text>
            <Text variant="bodySmall" color="inverse">{formatCUP(fare)}</Text>
          </View>
          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" color="inverse" className="opacity-60">
              {t('trip.platform_commission_pct', { pct: Math.round(commissionRate * 100) })}
            </Text>
            <Text variant="bodySmall" className="text-red-400">-{formatCUP(commissionAmount)}</Text>
          </View>
          <View className="h-px bg-neutral-600 my-2" />
          <View className="flex-row justify-between">
            <Text variant="body" color="inverse" className="font-bold">
              {isCash
                ? t('trip.collect_cash', { defaultValue: 'Cobras en efectivo' })
                : t('trip.net_earnings', { defaultValue: 'Ganancia neta' })}
            </Text>
            <Text variant="body" color="accent" className="font-bold">{formatCUP(netEarnings)}</Text>
          </View>
          {isCash && (
            <Text variant="caption" color="inverse" className="opacity-40 mt-1">
              {t('trip.commission_deducted', { defaultValue: 'La comisión se descuenta de tu saldo' })}
            </Text>
          )}
        </Card>

        {/* Trip stats */}
        {(ride.actual_distance_m != null || ride.estimated_distance_m > 0) && (
          <Card variant="filled" padding="md" className="bg-neutral-800 mb-4">
            <View className="flex-row gap-6">
              <View>
                <Text variant="caption" color="inverse" className="opacity-50">{t('trip.distance')}</Text>
                <Text variant="body" color="inverse" className="font-semibold">
                  {((ride.actual_distance_m ?? ride.estimated_distance_m) / 1000).toFixed(1)} km
                </Text>
              </View>
              <View>
                <Text variant="caption" color="inverse" className="opacity-50">{t('trip.duration')}</Text>
                <Text variant="body" color="inverse" className="font-semibold">
                  {Math.round((ride.actual_duration_s ?? ride.estimated_duration_s) / 60)} min
                </Text>
              </View>
              <View>
                <Text variant="caption" color="inverse" className="opacity-50">{t('trip.payment')}</Text>
                <Text variant="body" color="inverse" className="font-semibold">
                  {ride.payment_method === 'cash' ? t('trip.cash') : t('trip.tricicoin')}
                </Text>
              </View>
            </View>
          </Card>
        )}

        {/* Timestamps */}
        <Card variant="filled" padding="md" className="bg-neutral-800">
          <View className="flex-row justify-between mb-1">
            <Text variant="caption" color="inverse" className="opacity-50">{t('trip.created')}</Text>
            <Text variant="caption" color="inverse">{new Date(ride.created_at).toLocaleString('es-CU')}</Text>
          </View>
          {ride.accepted_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="inverse" className="opacity-50">{t('trip.accepted')}</Text>
              <Text variant="caption" color="inverse">{new Date(ride.accepted_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.completed_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="inverse" className="opacity-50">{t('trip.completed_at')}</Text>
              <Text variant="caption" color="inverse">{new Date(ride.completed_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.canceled_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="inverse" className="opacity-50">{t('trip.canceled_at')}</Text>
              <Text variant="caption" color="inverse">{new Date(ride.canceled_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
        </Card>
      </View>
    </Screen>
  );
}

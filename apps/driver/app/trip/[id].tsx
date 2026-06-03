import React, { useEffect, useState } from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { useTranslation } from '@tricigo/i18n';
import { colors } from '@tricigo/theme';
import { rideService } from '@tricigo/api/services/ride';
import { disputeService, lostItemService } from '@tricigo/api';
import { locationService } from '@tricigo/api/services/location';
import { formatCUP } from '@tricigo/utils';
import type { RideWithDriver, RidePricingSnapshot, RideLocationEvent, RideDispute, LostItem } from '@tricigo/types';
import { RideMapView } from '@/components/RideMapView';

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation('driver');

  const [ride, setRide] = useState<RideWithDriver | null>(null);
  const [pricing, setPricing] = useState<RidePricingSnapshot | null>(null);
  const [dispute, setDispute] = useState<RideDispute | null>(null);
  const [lostItem, setLostItem] = useState<LostItem | null>(null);
  const [routeCoords, setRouteCoords] = useState<{ latitude: number; longitude: number }[] | null>(null);
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

          // Fetch dispute if ride is disputed
          if (rideData && (rideData.status === 'disputed' || rideData.status === 'completed')) {
            try {
              const d = await disputeService.getDisputeByRide(id);
              if (!cancelled) setDispute(d);
            } catch { /* no dispute */ }
          }

          // Fetch lost item if ride completed
          if (rideData && rideData.status === 'completed') {
            try {
              const li = await lostItemService.getLostItemByRide(id);
              if (!cancelled) setLostItem(li);
            } catch { /* no lost item */ }
          }

          // Fetch route location events for completed/canceled rides
          if (rideData && (rideData.status === 'completed' || rideData.status === 'canceled')) {
            try {
              const events = await locationService.getRideLocationEvents(id);
              if (!cancelled && events.length > 0) {
                setRouteCoords(
                  events.map((e: RideLocationEvent) => ({
                    latitude: e.latitude,
                    longitude: e.longitude,
                  })),
                );
              }
            } catch {
              // Silently fail — route data is optional
            }
          }
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
      <Screen bg="lightPrimary" statusBarStyle="dark-content" padded>
        <View className="flex-1 items-center justify-center py-20">
          <ActivityIndicator size="large" color={colors.brand.orange} />
        </View>
      </Screen>
    );
  }

  if (!ride) {
    return (
      <Screen bg="lightPrimary" statusBarStyle="dark-content" padded>
        <View className="pt-4">
          <Pressable onPress={() => router.back()} className="mb-4" accessibilityRole="button" accessibilityLabel={t('common:back')}>
            <Text variant="body" color="accent">← {t('trip.back_to_home', { defaultValue: 'Volver' })}</Text>
          </Pressable>
          <Text variant="body" color="primary" className="opacity-50">{t('trip.not_found')}</Text>
        </View>
      </Screen>
    );
  }

  const fare = ride.final_fare_cup ?? ride.estimated_fare_cup;
  const isCompleted = ride.status === 'completed';
  // BUG-fare-display-parity: prefer snapshot `commission_amount` directo,
  // fallback a recalc con rate snapshoteada o live. Antes recalculaba
  // siempre `fare * rate`, causando drift de centavos cuando el snapshot
  // tenía el monto exacto en CUP enteros.
  const commissionRate = pricing?.commission_rate ?? 0.15;
  const commissionAmount = pricing?.commission_amount ?? Math.round(fare * commissionRate);
  // Tip: 100% para el driver, suma al neto. Antes "Ganancia neta" omitía
  // el tip aunque se renderizaba como banner separado más abajo.
  const tipAmount = ride.tip_amount ?? 0;
  const netEarnings = fare - commissionAmount + tipAmount;
  const isCash = ride.payment_method === 'cash' || ride.payment_method === 'mixed';

  return (
    <Screen scroll bg="lightPrimary" statusBarStyle="dark-content" padded>
      <View className="pt-4 pb-8">
        {/* Header */}
        <Pressable onPress={() => router.back()} className="mb-4" accessibilityRole="button" accessibilityLabel={t('common:back')}>
          <Text variant="body" color="accent">← {t('trip.back_to_home', { defaultValue: 'Volver' })}</Text>
        </Pressable>

        <View className="flex-row items-center justify-between mb-4">
          <Text variant="h3" color="primary">{t('trip.trip_detail', { defaultValue: 'Detalle del viaje' })}</Text>
          <View className={`px-3 py-1 rounded-full ${isCompleted ? 'bg-green-100' : 'bg-red-100'}`}>
            <Text variant="caption" className={isCompleted ? 'text-green-700' : 'text-red-700'}>
              {isCompleted ? t('trips_history.completed') : t('trips_history.canceled')}
            </Text>
          </View>
        </View>

        {/* Map */}
        <RideMapView
          pickupLocation={ride.pickup_location}
          dropoffLocation={ride.dropoff_location}
          routeCoordinates={routeCoords}
          height={180}
        />
        <View className="h-4" />

        {/* Route */}
        <Card theme="light" variant="filled" padding="md" className="bg-white mb-4">
          <View className="flex-row items-start mb-3" accessible={true} accessibilityLabel={t('a11y.pickup_address', { ns: 'common', address: ride.pickup_address })}>
            <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
            <View className="flex-1">
              <Text variant="caption" color="primary" className="opacity-50">{t('trip.pickup_address')}</Text>
              <Text variant="bodySmall" color="primary">{ride.pickup_address}</Text>
            </View>
          </View>
          <View className="flex-row items-start" accessible={true} accessibilityLabel={t('a11y.dropoff_address', { ns: 'common', address: ride.dropoff_address })}>
            <View className="w-3 h-3 rounded-full bg-neutral-400 mt-1 mr-3" />
            <View className="flex-1">
              <Text variant="caption" color="primary" className="opacity-50">{t('trip.dropoff_address')}</Text>
              <Text variant="bodySmall" color="primary">{ride.dropoff_address}</Text>
            </View>
          </View>
        </Card>

        {/* Fare + Commission */}
        <Card theme="light" variant="filled" padding="lg" className="bg-white mb-4" accessible={true} accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: formatCUP(fare) })}>
          <Text variant="h2" color="accent" className="text-center mb-4">{formatCUP(fare)}</Text>

          {/* Fare breakdown */}
          {pricing && (
            <>
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="primary" className="opacity-40">
                  {t('trip.base_fare', { defaultValue: 'Tarifa base' })}
                </Text>
                <Text variant="caption" color="primary" className="opacity-40">{formatCUP(pricing.base_fare ?? 0)}</Text>
              </View>
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="primary" className="opacity-40">
                  {t('trip.distance_charge', { defaultValue: 'Distancia' })} ({((ride.actual_distance_m ?? ride.estimated_distance_m ?? 0) / 1000).toFixed(1)} km)
                </Text>
                <Text variant="caption" color="primary" className="opacity-40">
                  {formatCUP(Math.round(((ride.actual_distance_m ?? ride.estimated_distance_m ?? 0) / 1000) * (pricing.per_km_rate ?? 0)))}
                </Text>
              </View>
              <View className="flex-row justify-between mb-1">
                <Text variant="caption" color="primary" className="opacity-40">
                  {t('trip.time_charge', { defaultValue: 'Tiempo' })} ({Math.round((ride.actual_duration_s ?? ride.estimated_duration_s ?? 0) / 60)} min)
                </Text>
                <Text variant="caption" color="primary" className="opacity-40">
                  {formatCUP(Math.round(((ride.actual_duration_s ?? ride.estimated_duration_s ?? 0) / 60) * (pricing.per_minute_rate ?? 0)))}
                </Text>
              </View>
              {(ride.surge_multiplier ?? 1) > 1 && (
                <View className="flex-row justify-between mb-1">
                  <Text variant="caption" className="text-orange-400">
                    {t('trip.surge', { defaultValue: 'Mal tiempo' })} {(ride.surge_multiplier ?? 1).toFixed(1)}x
                  </Text>
                  <Text variant="caption" className="text-orange-400">+{formatCUP(Math.round(fare * (1 - 1 / (ride.surge_multiplier ?? 1))))}</Text>
                </View>
              )}
              {(ride.tip_amount ?? 0) > 0 && (
                <View className="flex-row justify-between mb-1">
                  <Text variant="caption" className="text-green-400">
                    {t('trip.tip', { defaultValue: 'Propina' })}
                  </Text>
                  <Text variant="caption" className="text-green-400">+{formatCUP(ride.tip_amount ?? 0)}</Text>
                </View>
              )}
              <View className="h-px bg-[#E2E8F0] my-2" />
            </>
          )}

          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" color="primary" className="opacity-60">
              {t('trip.total_fare', { defaultValue: 'Tarifa total' })}
            </Text>
            <Text variant="bodySmall" color="primary">{formatCUP(fare)}</Text>
          </View>
          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" color="primary" className="opacity-60">
              {t('trip.platform_commission_pct', { pct: Math.round(commissionRate * 100) })}
            </Text>
            <Text variant="bodySmall" className="text-red-400">
              {/* BUG-fare-driver-hero-gross: consistencia con TripCompleteView. */}
              -{formatCUP(commissionAmount)} {t('trip.tc_equivalent', { tc: commissionAmount, defaultValue: '(= {{tc}} TC)' })}
            </Text>
          </View>
          {/* BUG-fare-driver-hero-gross: removido el bloque "Te llevás / Cobras
             en efectivo" + separator. El header de precio arriba ya muestra GROSS;
             el breakdown muestra la comisión; el net se entiende del cálculo. */}
          <Text variant="caption" color="primary" className="opacity-40 mt-1">
            {/* Caption siempre visible: la comisión SIEMPRE se descuenta del TC del driver. */}
            {t('trip.commission_deducted', { defaultValue: 'Se descuenta de tu saldo TriciCoin (1 CUP = 1 TC)' })}
          </Text>
        </Card>

        {/* Trip stats */}
        {(ride.actual_distance_m != null || ride.estimated_distance_m > 0) && (
          <Card theme="light" variant="filled" padding="md" className="bg-white mb-4">
            <View className="flex-row gap-6">
              <View accessible={true} accessibilityLabel={t('a11y.stat_distance', { ns: 'common', value: `${((ride.actual_distance_m ?? ride.estimated_distance_m) / 1000).toFixed(1)} km` })}>
                <Text variant="caption" color="primary" className="opacity-50">{t('trip.distance')}</Text>
                <Text variant="body" color="primary" className="font-semibold">
                  {((ride.actual_distance_m ?? ride.estimated_distance_m) / 1000).toFixed(1)} km
                </Text>
              </View>
              <View accessible={true} accessibilityLabel={t('a11y.stat_duration', { ns: 'common', value: `${Math.round((ride.actual_duration_s ?? ride.estimated_duration_s) / 60)} min` })}>
                <Text variant="caption" color="primary" className="opacity-50">{t('trip.duration')}</Text>
                <Text variant="body" color="primary" className="font-semibold">
                  {Math.round((ride.actual_duration_s ?? ride.estimated_duration_s) / 60)} min
                </Text>
              </View>
              <View accessible={true} accessibilityLabel={t('a11y.stat_payment', { ns: 'common', value: ride.payment_method === 'cash' ? t('trip.cash') : t('trip.tricicoin') })}>
                <Text variant="caption" color="primary" className="opacity-50">{t('trip.payment')}</Text>
                <Text variant="body" color="primary" className="font-semibold">
                  {ride.payment_method === 'cash' ? t('trip.cash') : t('trip.tricicoin')}
                </Text>
              </View>
            </View>
          </Card>
        )}

        {/* Dispute banner */}
        {dispute && !dispute.respondent_replied_at && dispute.status === 'open' && (
          <Pressable
            onPress={() => router.push(`/trip/dispute-respond/${dispute.id}`)}
            className="mb-4"
            accessibilityRole="button"
            accessibilityHint={t('a11y.dispute_action', { ns: 'common' })}
          >
            <Card theme="light" variant="filled" padding="md" className="bg-orange-50 border border-orange-200">
              <Text variant="body" color="primary" className="font-semibold mb-1">
                ⚠️ {t('dispute.incoming')}
              </Text>
              <Text variant="caption" color="primary" className="opacity-60 mb-2">
                {t('dispute.opened_by_rider')} · {dispute.reason}
              </Text>
              <Text variant="bodySmall" color="accent" className="font-semibold">
                {t('dispute.respond')} →
              </Text>
            </Card>
          </Pressable>
        )}

        {/* Dispute status (already responded) */}
        {dispute && dispute.respondent_replied_at && (
          <Card theme="light" variant="filled" padding="md" className="bg-white mb-4 border border-[#E2E8F0]">
            <Text variant="label" color="primary" className="mb-1">
              {t('dispute.status_' + dispute.status)}
            </Text>
            <Text variant="caption" color="primary" className="opacity-50">
              {dispute.reason} · {t('dispute.responded')}
            </Text>
          </Card>
        )}

        {/* Lost item banner (needs response) */}
        {lostItem && lostItem.driver_found === null && (
          <Pressable
            onPress={() => router.push(`/trip/lost-item/${lostItem.ride_id}`)}
            className="mb-4"
            accessibilityRole="button"
            accessibilityHint={t('a11y.lost_item_action', { ns: 'common' })}
          >
            <Card theme="light" variant="filled" padding="md" className="bg-amber-50 border border-amber-200">
              <Text variant="body" color="primary" className="font-semibold mb-1">
                📦 {t('lost_found.rider_reported')}
              </Text>
              <Text variant="caption" color="primary" className="opacity-60 mb-2">
                {lostItem.description.slice(0, 80)}{lostItem.description.length > 80 ? '…' : ''}
              </Text>
              <Text variant="bodySmall" color="accent" className="font-semibold">
                {t('lost_found.respond')} →
              </Text>
            </Card>
          </Pressable>
        )}

        {/* Lost item status (already responded) */}
        {lostItem && lostItem.driver_found !== null && (
          <Pressable
            onPress={() => router.push(`/trip/lost-item/${lostItem.ride_id}`)}
            className="mb-4"
            accessibilityRole="button"
            accessibilityLabel={t(`lost_found.status_${lostItem.status}`)}
          >
            <Card theme="light" variant="filled" padding="md" className="bg-white border border-[#E2E8F0]">
              <Text variant="label" color="primary" className="mb-1">
                📦 {t(`lost_found.status_${lostItem.status}`)}
              </Text>
              <Text variant="caption" color="primary" className="opacity-50">
                {lostItem.description.slice(0, 60)}{lostItem.description.length > 60 ? '…' : ''}
              </Text>
            </Card>
          </Pressable>
        )}

        {/* Timestamps */}
        <Card theme="light" variant="filled" padding="md" className="bg-white">
          <View className="flex-row justify-between mb-1">
            <Text variant="caption" color="primary" className="opacity-50">{t('trip.created')}</Text>
            <Text variant="caption" color="primary">{new Date(ride.created_at).toLocaleString('es-CU')}</Text>
          </View>
          {ride.accepted_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="primary" className="opacity-50">{t('trip.accepted')}</Text>
              <Text variant="caption" color="primary">{new Date(ride.accepted_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.completed_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="primary" className="opacity-50">{t('trip.completed_at')}</Text>
              <Text variant="caption" color="primary">{new Date(ride.completed_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.canceled_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="primary" className="opacity-50">{t('trip.canceled_at')}</Text>
              <Text variant="caption" color="primary">{new Date(ride.canceled_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
        </Card>
      </View>
    </Screen>
  );
}

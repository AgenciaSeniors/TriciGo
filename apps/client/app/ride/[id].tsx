import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, Share } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { disputeService, lostItemService } from '@tricigo/api';
import { locationService } from '@tricigo/api/services/location';
import { useFeatureFlag } from '@tricigo/api/hooks/useFeatureFlag';
import { formatTRC, formatCUP, cupToTrcCentavos, triggerHaptic } from '@tricigo/utils';
import { Ionicons } from '@expo/vector-icons';
import type { RideWithDriver, RidePricingSnapshot, RideLocationEvent, RideDispute, LostItem } from '@tricigo/types';
import { RideMapView } from '@/components/RideMapView';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { StatusBadge } from '@tricigo/ui/StatusBadge';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { useResponsive } from '@tricigo/ui/hooks/useResponsive';
import { colors } from '@tricigo/theme';
import { SkeletonCard } from '@tricigo/ui/Skeleton';

export default function RideDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation('rider');
  const { isTablet } = useResponsive();

  const STATUS_LABEL: Record<string, string> = {
    searching: t('ride.searching_driver'),
    accepted: t('ride.status_accepted'),
    driver_en_route: t('ride.status_driver_en_route'),
    arrived_at_pickup: t('ride.status_arrived_at_pickup'),
    in_progress: t('ride.status_in_progress'),
    completed: t('ride.timestamp_completed'),
    canceled: t('ride.timestamp_canceled'),
  };

  const disputesEnabled = useFeatureFlag('formal_disputes_enabled');
  const lostFoundEnabled = useFeatureFlag('lost_and_found_enabled');

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

          // Fetch dispute status if exists
          if (rideData && (rideData.status === 'completed' || rideData.status === 'disputed')) {
            try {
              const d = await disputeService.getDisputeByRide(id);
              if (!cancelled) setDispute(d);
            } catch { /* no dispute */ }
          }

          // Fetch lost item if ride is completed
          if (rideData && rideData.status === 'completed') {
            try {
              const li = await lostItemService.getLostItemByRide(id);
              if (!cancelled) setLostItem(li);
            } catch { /* no lost item */ }
          }

          // Fetch route location events for completed rides
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
        <View className="pt-4">
          <SkeletonCard lines={2} />
          <SkeletonCard lines={3} />
          <SkeletonCard lines={4} />
        </View>
      </Screen>
    );
  }

  if (!ride) {
    return (
      <Screen bg="white" padded>
        <View className="pt-4">
          <ScreenHeader title="" onBack={() => router.back()} />
          <Text variant="body" color="tertiary">{t('ride.not_found')}</Text>
        </View>
      </Screen>
    );
  }

  const fareTrc = ride.final_fare_trc ?? ride.estimated_fare_trc;
  const fareCup = ride.final_fare_cup ?? ride.estimated_fare_cup;
  const isCompleted = ride.status === 'completed';

  const handleCopyRideId = useCallback(async () => {
    if (!id) return;
    await Clipboard.setStringAsync(id);
    Toast.show({ type: 'success', text1: t('common:copied') });
    triggerHaptic('light');
  }, [id, t]);

  const handleShare = () => {
    if (ride.share_token) {
      Share.share({ message: `https://tricigo.app/ride/${ride.share_token}` });
    }
  };

  return (
    <Screen scroll bg="white" padded>
      <View className="pt-4 pb-8">
        {/* Header */}
        <ScreenHeader
          title={t('ride.ride_detail', { defaultValue: 'Detalle del viaje' })}
          onBack={() => router.back()}
          rightAction={
            <StatusBadge
              label={STATUS_LABEL[ride.status] ?? ride.status}
              variant={isCompleted ? 'success' : 'error'}
            />
          }
        />

        {/* Ride ID with copy */}
        <View className="flex-row items-center mb-2">
          <Text variant="caption" color="tertiary">ID: {id?.substring(0, 8)}</Text>
          <Pressable onPress={handleCopyRideId} hitSlop={8} className="ml-2" accessibilityRole="button" accessibilityLabel={t('common:copied')}>
            <Ionicons name="copy-outline" size={16} color={colors.neutral[400]} />
          </Pressable>
        </View>

        {/* Map */}
        <RideMapView
          pickupLocation={ride.pickup_location}
          dropoffLocation={ride.dropoff_location}
          routeCoordinates={routeCoords}
          height={isTablet ? 300 : 180}
        />
        <View className="h-4" />

        {/* Route */}
        <Card variant="outlined" padding="md" className="mb-4">
          <RouteSummary
            pickupAddress={ride.pickup_address}
            dropoffAddress={ride.dropoff_address}
            pickupLabel={t('ride.pickup')}
            dropoffLabel={t('ride.dropoff')}
          />
        </Card>

        {/* Driver info */}
        {ride.driver_name && (
          <Card variant="filled" padding="md" className="mb-4">
            <Text variant="label" className="mb-2">{t('ride.driver_info', { defaultValue: 'Conductor' })}</Text>
            <View className="flex-row items-center" accessible={true} accessibilityLabel={t('a11y.driver_info', { ns: 'common', name: ride.driver_name, rating: ride.driver_rating != null ? Number(ride.driver_rating).toFixed(1) : '—', vehicle: `${ride.vehicle_make ?? ''} ${ride.vehicle_model ?? ''} ${ride.vehicle_plate ?? ''}`.trim() })}>
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

          {ride.final_fare_trc != null && ride.estimated_fare_trc != null && ride.final_fare_trc !== ride.estimated_fare_trc && (
            <View className="flex-row justify-between mb-2">
              <Text variant="bodySmall" color="secondary">{t('ride.estimated_fare')}</Text>
              <Text variant="bodySmall" color="secondary" className="line-through">
                {formatTRC(ride.estimated_fare_trc)}
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
            <Text variant="h4">{ride.final_fare_trc != null ? t('ride.final_fare') : t('ride.estimated_fare')}</Text>
            <Text variant="h3" color="accent">{fareTrc != null ? formatTRC(fareTrc) : formatCUP(fareCup)}</Text>
          </View>
        </Card>

        {/* Trip stats */}
        {(ride.actual_distance_m != null || ride.estimated_distance_m > 0) && (
          <Card variant="outlined" padding="md" className="mb-4">
            <Text variant="label" className="mb-2">{t('ride.trip_stats', { defaultValue: 'Estadísticas' })}</Text>
            <View className="flex-row gap-6">
              <View accessible={true} accessibilityLabel={t('a11y.stat_distance', { ns: 'common', value: `${((ride.actual_distance_m ?? ride.estimated_distance_m) / 1000).toFixed(1)} km` })}>
                <Text variant="caption" color="secondary">{t('ride.distance')}</Text>
                <Text variant="body" className="font-semibold">
                  {((ride.actual_distance_m ?? ride.estimated_distance_m) / 1000).toFixed(1)} km
                </Text>
              </View>
              <View accessible={true} accessibilityLabel={t('a11y.stat_duration', { ns: 'common', value: `${Math.round((ride.actual_duration_s ?? ride.estimated_duration_s) / 60)} min` })}>
                <Text variant="caption" color="secondary">{t('ride.eta')}</Text>
                <Text variant="body" className="font-semibold">
                  {Math.round((ride.actual_duration_s ?? ride.estimated_duration_s) / 60)} min
                </Text>
              </View>
              <View accessible={true} accessibilityLabel={t('a11y.stat_payment', { ns: 'common', value: ride.payment_method === 'cash' ? t('payment.cash') : t('payment.tricicoin') })}>
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
          <View className="flex-row justify-between mb-1" accessible={true} accessibilityLabel={`${t('ride.timestamp_created')}: ${new Date(ride.created_at).toLocaleString('es-CU')}`}>
            <Text variant="caption" color="secondary">{t('ride.timestamp_created')}</Text>
            <Text variant="caption">{new Date(ride.created_at).toLocaleString('es-CU')}</Text>
          </View>
          {ride.accepted_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.timestamp_accepted')}</Text>
              <Text variant="caption">{new Date(ride.accepted_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.pickup_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.timestamp_pickup')}</Text>
              <Text variant="caption">{new Date(ride.pickup_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.completed_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.timestamp_completed')}</Text>
              <Text variant="caption">{new Date(ride.completed_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
          {ride.canceled_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.timestamp_canceled')}</Text>
              <Text variant="caption">{new Date(ride.canceled_at).toLocaleString('es-CU')}</Text>
            </View>
          )}
        </Card>

        {/* Dispute status card */}
        {dispute && (
          <Card variant="outlined" padding="md" className="mb-4 border-orange-200 bg-orange-50">
            <Text variant="label" className="mb-1">{t('dispute.your_dispute')}</Text>
            <View className="flex-row items-center justify-between">
              <Text variant="bodySmall" color="secondary">
                {t(`dispute.reason_${dispute.reason}`)}
              </Text>
              <StatusBadge
                label={t(`dispute.status_${dispute.status}`)}
                variant={dispute.status === 'resolved' ? 'success' : dispute.status === 'denied' ? 'error' : 'warning'}
              />
            </View>
            {dispute.resolution_notes && (
              <View className="mt-2 pt-2 border-t border-orange-200">
                <Text variant="caption" color="secondary">{t('dispute.resolution_notes')}</Text>
                <Text variant="bodySmall">{dispute.resolution_notes}</Text>
              </View>
            )}
            {dispute.refund_amount_trc != null && dispute.refund_amount_trc > 0 && (
              <View className="mt-1">
                <Text variant="caption" color="secondary">
                  {t('dispute.refund_amount')}: {formatTRC(dispute.refund_amount_trc)}
                </Text>
              </View>
            )}
          </Card>
        )}

        {/* Dispute button (completed rides without existing dispute) — kept for backward compat */}
        {disputesEnabled && isCompleted && !dispute && !lostItem && null}

        {/* Lost item status card */}
        {lostItem && (
          <Card variant="outlined" padding="md" className="mb-4 border-amber-200 bg-amber-50">
            <Text variant="label" className="mb-1">{t('lost_found.title')}</Text>
            <View className="flex-row items-center justify-between">
              <Text variant="bodySmall" color="secondary">
                {t(`lost_found.category_${lostItem.category}`)}
              </Text>
              <StatusBadge
                label={t(`lost_found.status_${lostItem.status}`)}
                variant={lostItem.status === 'returned' ? 'success' : lostItem.status === 'closed' || lostItem.status === 'not_found' ? 'error' : 'warning'}
              />
            </View>
            {lostItem.driver_found === true && lostItem.return_location && (
              <View className="mt-2 pt-2 border-t border-amber-200">
                <Text variant="caption" color="secondary">{t('lost_found.return_location')}</Text>
                <Text variant="bodySmall">{lostItem.return_location}</Text>
              </View>
            )}
            {lostItem.return_fee_cup != null && lostItem.return_fee_cup > 0 && (
              <View className="mt-1">
                <Text variant="caption" color="secondary">
                  {t('lost_found.return_fee')}: {lostItem.return_fee_cup} CUP
                </Text>
              </View>
            )}
          </Card>
        )}

        {/* Prominent action CTAs for completed rides */}
        {isCompleted && (disputesEnabled || lostFoundEnabled) && (!dispute || !lostItem) && (
          <Card variant="elevated" padding="lg" className="mb-4 bg-neutral-50">
            <View className="gap-3">
              {disputesEnabled && !dispute && (
                <Pressable
                  onPress={() => router.push(`/ride/dispute/${id}`)}
                  className="flex-row items-center bg-white border border-orange-200 rounded-xl px-4 py-3.5"
                  accessibilityRole="button"
                  accessibilityLabel={t('ride.report_issue')}
                >
                  <Ionicons name="warning-outline" size={22} color={colors.primary[500]} />
                  <Text variant="body" className="font-semibold ml-3 flex-1">{t('ride.report_issue')}</Text>
                  <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
                </Pressable>
              )}
              {lostFoundEnabled && !lostItem && ride.driver_user_id && (
                <Pressable
                  onPress={() => router.push(`/ride/lost-item/${id}?driverId=${ride.driver_user_id}`)}
                  className="flex-row items-center bg-white border border-amber-200 rounded-xl px-4 py-3.5"
                  accessibilityRole="button"
                  accessibilityLabel={t('ride.lost_item')}
                >
                  <Ionicons name="search-outline" size={22} color={colors.primary[500]} />
                  <Text variant="body" className="font-semibold ml-3 flex-1">{t('ride.lost_item')}</Text>
                  <Ionicons name="chevron-forward" size={20} color={colors.neutral[400]} />
                </Pressable>
              )}
            </View>
          </Card>
        )}

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

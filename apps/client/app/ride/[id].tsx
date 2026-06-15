import React, { useEffect, useState, useCallback } from 'react';
import { View, Pressable, Share, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { rideService } from '@tricigo/api/services/ride';
import { disputeService, lostItemService, deliveryService, blockService } from '@tricigo/api';
import type { DeliveryDetails } from '@tricigo/api';
import { locationService } from '@tricigo/api/services/location';
import { useFeatureFlag } from '@tricigo/api/hooks/useFeatureFlag';
import { formatTRC, formatCUP, formatUSD, cupToUsd, DEFAULT_EXCHANGE_RATE, triggerHaptic, logger, formatTimestamp, buildShareUrl, riderChargedTotal, riderChargedTotalTrc, getErrorMessage } from '@tricigo/utils';
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
  const { t: tc } = useTranslation('common');
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
  // BUG-G1b: when the ride is a delivery (ride_mode='cargo'), the rider
  // needs to see the 4-digit OTP so they can hand it to the recipient.
  // The driver will ask for it at drop-off to validate via validate_delivery_otp.
  // delivery_details is loaded separately because RideWithDriver doesn't
  // include it — RLS allows the customer to read it for their own rides.
  const [deliveryDetails, setDeliveryDetails] = useState<DeliveryDetails | null>(null);

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

          // Fetch delivery details when this is a cargo ride. We need
          // the OTP column too so the customer can share it with the
          // recipient — getDeliveryDetails() does SELECT * so it's
          // already included.
          if (rideData && rideData.ride_mode === 'cargo') {
            try {
              const dd = await deliveryService.getDeliveryDetails(id);
              if (!cancelled && dd) setDeliveryDetails(dd);
            } catch { /* no delivery_details — non-blocking */ }
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
        logger.error('Error loading ride detail', { error: String(err) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [id]);

  const handleCopyRideId = useCallback(async () => {
    if (!id) return;
    await Clipboard.setStringAsync(id);
    Toast.show({ type: 'success', text1: t('common:copied') });
    triggerHaptic('light');
  }, [id, t]);

  if (loading) {
    return (
      <Screen bg="cuban" padded>
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
      <Screen bg="cuban" padded>
        <View className="pt-4">
          <ScreenHeader title="" onBack={() => router.back()} />
          <Text variant="body" color="tertiary">{t('ride.not_found')}</Text>
        </View>
      </Screen>
    );
  }

  // BUG-fare-display-parity: "Total cobrado" debe incluir el tip post-add_tip.
  // El wallet del rider fue debitado por `final_fare_cup + tip_amount` pero
  // antes la UI mostraba solo `final_fare_cup` → discrepancia visible.
  const fareTrc = riderChargedTotalTrc(ride);
  const fareCup = riderChargedTotal(ride);
  // BUG-293 parity: only payment_method='tricicoin' denominates in TRC.
  // final_fare_trc is set for every ride (1:1 CUP peg) so it can't pick
  // the currency — that's why cash rides were shown as "TRC". Mirror
  // rides.tsx and RideCompleteView.
  const showTrc = ride.payment_method === 'tricicoin';
  const isCompleted = ride.status === 'completed';

  const handleShare = () => {
    if (ride.share_token) {
      Share.share({ message: buildShareUrl(ride.share_token) });
    }
  };

  // Share the delivery tracking link + OTP with the recipient via the
  // OS share sheet (WhatsApp, SMS, etc.). Combines the public tracking
  // URL with the 4-digit code so a single message gives the recipient
  // everything they need to follow the ride and hand the code to the
  // driver at drop-off.
  const handleShareDeliveryOtp = async () => {
    if (!ride.share_token || !deliveryDetails?.delivery_otp) return;
    const trackUrl = buildShareUrl(ride.share_token);
    const message = t('delivery.otp_share_message', {
      defaultValue: 'TriciGo: te envío un paquete. Sigue el viaje aquí: {{url}}\n\nCódigo para recibirlo: {{otp}}',
      url: trackUrl,
      otp: deliveryDetails.delivery_otp,
    });
    await Share.share({ message });
    triggerHaptic('light');
  };

  const handleCopyOtp = async () => {
    if (!deliveryDetails?.delivery_otp) return;
    await Clipboard.setStringAsync(deliveryDetails.delivery_otp);
    Toast.show({ type: 'success', text1: t('delivery.otp_copied', { defaultValue: 'Código copiado' }) });
    triggerHaptic('light');
  };

  const isCargoActive = ride.ride_mode === 'cargo'
    && ['accepted', 'driver_en_route', 'arrived_at_pickup', 'in_progress', 'arrived_at_destination'].includes(ride.status);

  return (
    <Screen scroll bg="cuban" padded>
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

        {/* Delivery OTP — visible during active cargo rides so the
            customer can share the code with the recipient before the
            driver arrives. Bonus: surfaces recipient + package info. */}
        {isCargoActive && deliveryDetails && (
          <Card variant="elevated" padding="lg" className="mb-4">
            <View className="flex-row items-center mb-2">
              <Ionicons name="cube" size={18} color={colors.brand.orange} />
              <Text variant="label" className="ml-2">
                {t('delivery.share_with_recipient', { defaultValue: 'Comparte con el destinatario' })}
              </Text>
            </View>
            {deliveryDetails.delivery_otp && (
              <>
                <Text variant="caption" color="secondary" className="mb-2">
                  {t('delivery.otp_helper', {
                    defaultValue: 'El conductor pedirá este código al destinatario para confirmar la entrega.',
                  })}
                </Text>
                <Pressable
                  onPress={handleCopyOtp}
                  className="bg-primary-50 rounded-lg py-4 mb-3 items-center"
                  accessibilityRole="button"
                  accessibilityLabel={t('delivery.otp_copy', { defaultValue: 'Copiar código' })}
                >
                  <Text
                    variant="h1"
                    color="accent"
                    className="font-bold tracking-widest"
                    style={{ letterSpacing: 8 }}
                  >
                    {deliveryDetails.delivery_otp}
                  </Text>
                  <Text variant="caption" color="secondary" className="mt-1">
                    {t('delivery.tap_to_copy', { defaultValue: 'Toca para copiar' })}
                  </Text>
                </Pressable>
              </>
            )}
            {ride.share_token && (
              <Button
                title={t('delivery.share_link_and_otp', { defaultValue: 'Compartir enlace y código' })}
                onPress={handleShareDeliveryOtp}
                size="lg"
                fullWidth
              />
            )}
            {deliveryDetails.recipient_name && (
              <View className="flex-row justify-between mt-3 pt-3 border-t border-neutral-200">
                <Text variant="caption" color="secondary">
                  {t('delivery.recipient', { defaultValue: 'Destinatario' })}
                </Text>
                <Text variant="caption" className="font-semibold">{deliveryDetails.recipient_name}</Text>
              </View>
            )}
            {deliveryDetails.recipient_phone && (
              <View className="flex-row justify-between mt-1">
                <Text variant="caption" color="secondary">
                  {t('delivery.recipient_phone', { defaultValue: 'Teléfono' })}
                </Text>
                <Text variant="caption">{deliveryDetails.recipient_phone}</Text>
              </View>
            )}
          </Card>
        )}

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

          {/* A2 (2026-06-04): desglose reconciliable. Antes mostraba
              base + per_km×distancia + per_min×tiempo, que NO suma el total
              (la tarifa usa una duración neutra oculta — BUG-221 — y los
              completados usan paridad estricta, no recálculo por distancia
              real). Ahora: "Tarifa del viaje" (subtotal pre-descuento) →
              descuento/espera/propina → total, que SÍ cuadra. Distancia y
              duración se muestran en "Estadísticas" abajo. */}
          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" color="secondary">{t('ride.trip_fare', { defaultValue: 'Tarifa del viaje' })}</Text>
            <Text variant="bodySmall">{formatCUP(pricing?.subtotal ?? ride.estimated_fare_cup)}</Text>
          </View>

          {ride.discount_amount_cup > 0 && (
            <View className="flex-row justify-between mb-2">
              <Text variant="bodySmall" className="text-green-600">{t('ride.discount')}</Text>
              <Text variant="bodySmall" className="text-green-600">-{formatCUP(ride.discount_amount_cup)}</Text>
            </View>
          )}

          {/* A2: espera y propina como líneas explícitas para que el desglose
              reconcilie con el Total (subtotal − descuento + espera + propina). */}
          {(ride.wait_time_charge_cup ?? 0) > 0 && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.wait_charge', { defaultValue: 'Cargo por espera' })}</Text>
              <Text variant="caption">+{formatCUP(ride.wait_time_charge_cup)}</Text>
            </View>
          )}
          {(ride.tip_amount ?? 0) > 0 && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.tip', { defaultValue: 'Propina' })}</Text>
              <Text variant="caption">+{formatCUP(ride.tip_amount)}</Text>
            </View>
          )}

          <View className="h-px bg-neutral-200 my-2" />
          <View className="flex-row justify-between items-end">
            <Text variant="h4">{ride.final_fare_cup != null ? t('ride.final_fare') : t('ride.estimated_fare')}</Text>
            <View className="items-end">
              <Text variant="h3" color="accent">{showTrc && fareTrc != null ? formatTRC(fareTrc) : formatCUP(fareCup)}</Text>
              <Text variant="caption" color="secondary">
                {/* BUG-fare-trc-usd: usar cupToUsd(CUP, rate). `fareTrc` viene de
                    `riderChargedTotalTrc(ride)` que retorna `final_fare_trc + tip`
                    en USD-cents post-Wallet-v2 \u2014 pasarlo a trcToUsd da ~5.5\u00d7 chico. */}
                {'\u2248'} {formatUSD(cupToUsd(fareCup, ride.exchange_rate_usd_cup ?? DEFAULT_EXCHANGE_RATE))}
              </Text>
            </View>
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
          <View className="flex-row justify-between mb-1" accessible={true} accessibilityLabel={`${t('ride.timestamp_created')}: ${formatTimestamp(ride.created_at, 'absolute')}`}>
            <Text variant="caption" color="secondary">{t('ride.timestamp_created')}</Text>
            <Text variant="caption">{formatTimestamp(ride.created_at, 'absolute')}</Text>
          </View>
          {ride.accepted_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.timestamp_accepted')}</Text>
              <Text variant="caption">{formatTimestamp(ride.accepted_at, 'absolute')}</Text>
            </View>
          )}
          {ride.pickup_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.timestamp_pickup')}</Text>
              <Text variant="caption">{formatTimestamp(ride.pickup_at, 'absolute')}</Text>
            </View>
          )}
          {ride.completed_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.timestamp_completed')}</Text>
              <Text variant="caption">{formatTimestamp(ride.completed_at, 'absolute')}</Text>
            </View>
          )}
          {ride.canceled_at && (
            <View className="flex-row justify-between mb-1">
              <Text variant="caption" color="secondary">{t('ride.timestamp_canceled')}</Text>
              <Text variant="caption">{formatTimestamp(ride.canceled_at, 'absolute')}</Text>
            </View>
          )}
        </Card>

        {/* Dispute status card */}
        {dispute && (
          <Card variant="outlined" padding="md" className="mb-4 border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/30">
            <Text variant="label" className="mb-1">{t('dispute.your_dispute')}</Text>
            <View className="flex-row items-center justify-between">
              <Text variant="bodySmall" color="secondary">
                {t(`dispute.reason_${dispute.reason}`)}
              </Text>
              <StatusBadge
                label={t(`dispute.status_${dispute.status}`)}
                variant={
                  dispute.status === 'resolved_rider'
                    ? 'success'
                    : dispute.status === 'resolved_driver'
                      ? 'error'
                      : 'warning'
                }
              />
            </View>
            {dispute.resolution_notes && (
              <View className="mt-2 pt-2 border-t border-orange-200 dark:border-orange-800">
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
          <Card variant="outlined" padding="md" className="mb-4 border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30">
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
              <View className="mt-2 pt-2 border-t border-amber-200 dark:border-amber-800">
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
          <Card variant="elevated" padding="lg" className="mb-4 bg-neutral-50 dark:bg-neutral-800">
            <View className="gap-3">
              {disputesEnabled && !dispute && (
                <Pressable
                  onPress={() => router.push(`/ride/dispute/${id}`)}
                  className="flex-row items-center bg-white dark:bg-neutral-800 border border-orange-200 dark:border-orange-800 rounded-xl px-4 py-3.5"
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
                  className="flex-row items-center bg-white dark:bg-neutral-800 border border-amber-200 dark:border-amber-800 rounded-xl px-4 py-3.5"
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

        {/* Block driver — available on any completed ride with a driver (Apple 1.2) */}
        {isCompleted && ride.driver_user_id && (
          <Pressable
            onPress={() => {
              const driverUserId = ride.driver_user_id!;
              Alert.alert(
                tc('block.confirm_title', { defaultValue: '¿Bloquear conductor?' }),
                tc('block.confirm_msg', { defaultValue: 'No volverás a emparejarte con este conductor en el futuro.' }),
                [
                  { text: tc('cancel', { defaultValue: 'Cancelar' }), style: 'cancel' },
                  {
                    text: tc('block.block_action', { defaultValue: 'Bloquear' }),
                    style: 'destructive',
                    onPress: async () => {
                      try {
                        await blockService.blockUser(driverUserId);
                        Toast.show({ type: 'success', text1: tc('block.blocked_ok', { defaultValue: 'Conductor bloqueado' }) });
                      } catch (err) {
                        Toast.show({ type: 'error', text1: getErrorMessage(err) });
                      }
                    },
                  },
                ],
              );
            }}
            className="flex-row items-center bg-white dark:bg-neutral-800 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3.5 mb-4"
            accessibilityRole="button"
            accessibilityLabel={tc('block.block_driver', { defaultValue: 'Bloquear conductor' })}
          >
            <Ionicons name="ban-outline" size={22} color={colors.primary[500]} />
            <Text variant="body" className="font-semibold ml-3 flex-1">{tc('block.block_driver', { defaultValue: 'Bloquear conductor' })}</Text>
          </Pressable>
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

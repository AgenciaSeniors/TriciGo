/**
 * TripCompleteView — extracted from DriverTripView for PR-A.
 *
 * Renders the post-trip experience: large earnings amount, trip summary,
 * commission breakdown, mixed-payment cobranza split if applicable, tip
 * received banner, surge indicator, optional receipt download (native
 * only), excess-distance justification (BUG-222), rider rating, and the
 * "Listo" CTA that returns the driver to the home/searching screen.
 *
 * Behavior + visuals + i18n keys preserved verbatim. Migration to
 * `midnightEmber` tokens happens in PR-B; microcopy unification in PR-C.
 */
import React, { useEffect, useState } from 'react';
import { View, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { DraggableSheet } from '@tricigo/ui/DraggableSheet';
import { formatCUP, formatTRC, generateReceiptHTML, triggerHaptic } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { walletService, rideService } from '@tricigo/api';
import type { RideWithRider } from '@tricigo/types';
import { useDriverRideStore } from '@/stores/ride.store';
import { useDriverRideActions } from '@/hooks/useDriverRide';
import { useDriverStore } from '@/stores/driver.store';
import { RiderRatingSheet } from '../RiderRatingSheet';
import { ExcessDistanceSheet } from '../ExcessDistanceSheet';

export function TripCompleteView() {
  const { t } = useTranslation('driver');
  const activeTrip = useDriverRideStore((s) => s.activeTrip);
  const driverProfile = useDriverStore((s) => s.profile);
  const { clearCompletedTrip } = useDriverRideActions();
  const [commissionRate, setCommissionRate] = useState(0.15);
  const [rideWithRider, setRideWithRider] = useState<RideWithRider | null>(null);
  const [showRating, setShowRating] = useState(true);
  // BUG-222: show excess-distance justification modal first if driver
  // exceeded 1.3× the estimated distance and hasn't yet provided a reason.
  const excessMeters = activeTrip?.excess_distance_uncharged_m ?? 0;
  const alreadyJustified = !!activeTrip?.excess_distance_reason;
  const [showExcessSheet, setShowExcessSheet] = useState(excessMeters > 0 && !alreadyJustified);

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
  }, [activeTrip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Driver must tap "Listo" manually to dismiss — no auto-advance.
  // This ensures they have time to see earnings, rate the rider, and download receipt.

  if (!activeTrip) return null;

  const fare = activeTrip.final_fare_cup ?? activeTrip.estimated_fare_cup;
  const commissionAmount = Math.round(fare * commissionRate);
  const netEarnings = fare - commissionAmount;
  const isCash = activeTrip.payment_method === 'cash' || activeTrip.payment_method === 'mixed';

  const handleDownloadReceipt = async () => {
    if (!activeTrip) return;
    try {
      const data = await rideService.getReceiptData(activeTrip.id, 'driver');
      // Localise the raw payment_method enum on the way out.
      const paymentLabel =
        activeTrip.payment_method === 'cash'
          ? t('payment.cash', { defaultValue: 'Efectivo' })
          : activeTrip.payment_method === 'corporate'
            ? t('payment.corporate', { defaultValue: 'Cuenta corporativa' })
            : activeTrip.payment_method === 'mixed'
              ? t('payment.mixed', { defaultValue: 'Mixto' })
              : 'TriciCoin';
      const html = generateReceiptHTML({ ...data, paymentMethod: paymentLabel });
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Recibo TriciGo' });
      }
    } catch (err) {
      console.error('Receipt generation failed:', err);
    }
  };

  return (
    <DraggableSheet
      snapPoints={['50%', '90%']}
      initialIndex={0}
      theme="dark"
      scrollable
    >
      <View className="pt-8 items-center">
        {/* DT-6: Earnings delta — large green amount at top */}
        {activeTrip.final_fare_cup != null && (
          <Text variant="h2" style={{
            color: '#22C55E',
            textAlign: 'center',
            marginBottom: 8,
          }}>
            {t('trip.earned_this_ride', {
              amount: `$${Math.round((activeTrip.final_fare_cup || 0) * 0.85).toLocaleString()}`,
            })}
          </Text>
        )}

        <View className="w-20 h-20 rounded-full bg-success items-center justify-center mb-4">
          <Ionicons name="checkmark" size={40} color="white" />
        </View>

        <Text variant="h3" color="inverse" className="mb-2">
          {t('trip.trip_completed')}
        </Text>

        {/* DT-6: Compressed trip summary — single line */}
        <Text variant="bodySmall" style={{ color: '#9CA3AF', textAlign: 'center', marginBottom: 8 }}>
          {formatCUP(activeTrip.final_fare_cup ?? activeTrip.estimated_fare_cup)} · {((activeTrip.actual_distance_m ?? 0) / 1000).toFixed(1)} km · {Math.ceil((activeTrip.actual_duration_s || 0) / 60)} min
        </Text>

        {/* Commission breakdown */}
        <Card forceDark variant="filled" padding="md" className="w-full bg-[#1a1a2e] mb-6 rounded-2xl border border-white/[0.06]">
          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" style={{ color: '#9CA3AF' }}>
              {t('trip.total_fare', { defaultValue: 'Tarifa total' })}
            </Text>
            <Text variant="bodySmall" color="inverse">
              {formatCUP(fare)}
            </Text>
          </View>
          <View className="flex-row justify-between mb-2">
            <Text variant="bodySmall" style={{ color: '#9CA3AF' }}>
              {t('trip.platform_commission', { defaultValue: 'Comisión plataforma (15%)' })}
            </Text>
            <Text variant="bodySmall" style={{ color: '#EF4444' }}>
              -{formatCUP(commissionAmount)}
            </Text>
          </View>
          <View className="h-px my-2" style={{ backgroundColor: 'rgba(255,255,255,0.06)' }} />
          <View className="flex-row justify-between">
            <Text variant="body" color="inverse" className="font-bold">
              {isCash ? t('trip.collect_cash', { defaultValue: 'Cobras en efectivo' }) : t('trip.net_earnings', { defaultValue: 'Ganancia neta' })}
            </Text>
            <Text variant="body" color="accent" className="font-bold">
              {formatCUP(netEarnings)}
            </Text>
          </View>
          {isCash && (
            <Text variant="caption" style={{ color: '#9CA3AF' }} className="mt-1">
              {t('trip.commission_deducted', { defaultValue: 'La comisión se descuenta de tu saldo' })}
            </Text>
          )}
          {activeTrip.payment_method === 'mixed' && (
            <View className="mt-3 p-3 rounded-xl" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
              <Text variant="body" color="inverse" className="font-bold mb-1">
                {t('trip.collect_cash_amount', {
                  amount: formatCUP((activeTrip as any).cash_amount_cup ?? Math.round(fare * 0.5)),
                  defaultValue: `Cobrar $${((activeTrip as any).cash_amount_cup ?? Math.round(fare * 0.5)).toLocaleString()} en efectivo`,
                })}
              </Text>
              <Text variant="caption" style={{ color: '#9CA3AF' }}>
                {t('trip.wallet_portion', {
                  amount: formatCUP((activeTrip as any).wallet_amount_cup ?? Math.round(fare * 0.5)),
                  defaultValue: `$${((activeTrip as any).wallet_amount_cup ?? Math.round(fare * 0.5)).toLocaleString()} del wallet del pasajero`,
                })}
              </Text>
            </View>
          )}
        </Card>

        {/* Tip received */}
        {(activeTrip.tip_amount ?? 0) > 0 && (
          <Card forceDark variant="filled" padding="md" className="w-full bg-[#1a1a2e] mb-6 rounded-2xl border border-white/[0.06]">
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

        {/* Receipt download: native-only. expo-print.printToFileAsync is not
            implemented on web (returns undefined), so the button is hidden
            there to avoid a destructure crash. Native APK keeps the feature. */}
        {Platform.OS !== 'web' && (
          <Button
            title={t('trip.download_receipt', { defaultValue: 'Descargar recibo' })}
            variant="outline"
            size="lg"
            fullWidth
            forceDark
            onPress={handleDownloadReceipt}
            className="mb-3"
          />
        )}

        {/* BUG-222: excess-distance justification (shown FIRST, blocks rating) */}
        {showExcessSheet && (
          <View className="w-full mb-3">
            <ExcessDistanceSheet
              rideId={activeTrip.id}
              excessMeters={excessMeters}
              chargeableM={Math.max(0, (activeTrip.actual_distance_m ?? 0) - excessMeters)}
              actualM={activeTrip.actual_distance_m ?? 0}
              onComplete={() => setShowExcessSheet(false)}
            />
          </View>
        )}

        {/* Rider rating (only after excess sheet dismissed) */}
        {!showExcessSheet && showRating && rideWithRider && driverProfile?.user_id && (
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
          title={t('trip.done', { defaultValue: 'Listo' })}
          size="lg"
          fullWidth
          onPress={() => {
            // UX: give positive feedback on trip dismissal instead of an
            // abrupt cut to the home "searching" screen. Haptic + toast
            // make the transition feel intentional and celebrate the driver.
            triggerHaptic('success');
            Toast.show({
              type: 'success',
              text1: t('trip.done_toast_title', { defaultValue: '¡Viaje cobrado!' }),
              text2: t('trip.done_toast_subtitle', { defaultValue: 'Buscando tu próximo viaje...' }),
              visibilityTime: 2500,
            });
            clearCompletedTrip();
          }}
        />
      </View>
    </DraggableSheet>
  );
}

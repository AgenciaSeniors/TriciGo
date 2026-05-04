/**
 * TripCompleteView — Midnight Ember edition (PR-B).
 *
 * Post-trip experience: large earnings amount, trip summary, commission
 * breakdown, mixed-payment cobranza split, tip received banner, surge
 * indicator, optional receipt download (native only), excess-distance
 * justification (BUG-222), rider rating, and the "Listo" CTA.
 *
 * v2 tokenization:
 *   - Hero earnings: `state.success` + `text.heroLg` (was raw `#22C55E`
 *     + `variant="h2"`).
 *   - Checkmark circle: `state.success` background (was `bg-success`
 *     Tailwind class).
 *   - Commission card: raw `<View>` + `map.bg.elevated` (was `<Card
 *     forceDark>` + `bg-[#1a1a2e]`).
 *   - Tip card: same migration.
 *   - "Tarifa total" / "Comisión" labels: `text.secondary`.
 *   - Commission deduction value: `state.danger`.
 *   - Net earnings value: `accent[500]` to match the IncomingRideCard
 *     hero color so "Ganás" reads consistently across screens.
 */
import React, { useEffect, useState } from 'react';
import { View, Platform } from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { DraggableSheet } from '@tricigo/ui/DraggableSheet';
import { formatCUP, formatTRC, generateReceiptHTML, triggerHaptic } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { walletService, rideService } from '@tricigo/api';
import type { RideWithRider } from '@tricigo/types';
import { useDriverRideStore } from '@/stores/ride.store';
import { useDriverRideActions } from '@/hooks/useDriverRide';
import { useDriverStore } from '@/stores/driver.store';
import { midnightEmber } from '@tricigo/theme';
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

  // Reusable card style for the commission + tip sections.
  const surfaceCard = {
    width: '100%' as const,
    backgroundColor: midnightEmber.map.bg.elevated,
    borderColor: midnightEmber.map.line.hairline,
    borderWidth: 1,
    borderRadius: midnightEmber.radius.card,
    padding: 14,
    marginBottom: 16,
  };

  return (
    <DraggableSheet
      snapPoints={['50%', '90%']}
      initialIndex={0}
      theme="dark"
      scrollable
    >
      <View style={{ paddingTop: 24, alignItems: 'center' }}>
        {/* Earnings hero — large success amount at top */}
        {activeTrip.final_fare_cup != null && (
          <Text
            style={{
              ...midnightEmber.text.heroLg,
              color: midnightEmber.state.success,
              textAlign: 'center',
              marginBottom: 8,
            }}
          >
            {t('trip.earned_this_ride', {
              amount: `$${Math.round((activeTrip.final_fare_cup || 0) * 0.85).toLocaleString()}`,
            })}
          </Text>
        )}

        {/* Checkmark circle */}
        <View
          style={{
            width: 80,
            height: 80,
            borderRadius: 40,
            backgroundColor: midnightEmber.state.success,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 16,
          }}
        >
          <Ionicons name="checkmark" size={40} color={midnightEmber.map.text.onAccent} />
        </View>

        <Text
          variant="h3"
          style={{ color: midnightEmber.map.text.primary, marginBottom: 8 }}
        >
          {t('trip.trip_completed')}
        </Text>

        {/* Compressed trip summary — single line */}
        <Text
          variant="bodySmall"
          style={{
            color: midnightEmber.map.text.secondary,
            textAlign: 'center',
            marginBottom: 12,
          }}
        >
          {formatCUP(activeTrip.final_fare_cup ?? activeTrip.estimated_fare_cup)} · {((activeTrip.actual_distance_m ?? 0) / 1000).toFixed(1)} km · {Math.ceil((activeTrip.actual_duration_s || 0) / 60)} min
        </Text>

        {/* Commission breakdown */}
        <View style={surfaceCard}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text variant="bodySmall" style={{ color: midnightEmber.map.text.secondary }}>
              {t('trip.total_fare', { defaultValue: 'Tarifa total' })}
            </Text>
            <Text variant="bodySmall" style={{ color: midnightEmber.map.text.primary }}>
              {formatCUP(fare)}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text variant="bodySmall" style={{ color: midnightEmber.map.text.secondary }}>
              {t('trip.platform_commission', { defaultValue: 'Comisión plataforma (15%)' })}
            </Text>
            <Text variant="bodySmall" style={{ color: midnightEmber.state.danger }}>
              -{formatCUP(commissionAmount)}
            </Text>
          </View>
          <View style={{ height: 1, marginVertical: 6, backgroundColor: midnightEmber.map.line.hairline }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text
              variant="body"
              style={{ color: midnightEmber.map.text.primary, fontWeight: '700' }}
            >
              {isCash ? t('trip.collect_cash', { defaultValue: 'Cobras en efectivo' }) : t('trip.net_earnings', { defaultValue: 'Ganancia neta' })}
            </Text>
            <Text
              variant="body"
              style={{ color: midnightEmber.accent[500], fontWeight: '700' }}
            >
              {formatCUP(netEarnings)}
            </Text>
          </View>
          {isCash && (
            <Text
              variant="caption"
              style={{ color: midnightEmber.map.text.tertiary, marginTop: 4 }}
            >
              {t('trip.commission_deducted', { defaultValue: 'La comisión se descuenta de tu saldo' })}
            </Text>
          )}
          {activeTrip.payment_method === 'mixed' && (
            <View
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: midnightEmber.radius.input,
                backgroundColor: midnightEmber.map.bg.surface,
              }}
            >
              <Text
                variant="body"
                style={{
                  color: midnightEmber.map.text.primary,
                  fontWeight: '700',
                  marginBottom: 4,
                }}
              >
                {t('trip.collect_cash_amount', {
                  amount: formatCUP((activeTrip as any).cash_amount_cup ?? Math.round(fare * 0.5)),
                  defaultValue: `Cobrar $${((activeTrip as any).cash_amount_cup ?? Math.round(fare * 0.5)).toLocaleString()} en efectivo`,
                })}
              </Text>
              <Text
                variant="caption"
                style={{ color: midnightEmber.map.text.tertiary }}
              >
                {t('trip.wallet_portion', {
                  amount: formatCUP((activeTrip as any).wallet_amount_cup ?? Math.round(fare * 0.5)),
                  defaultValue: `$${((activeTrip as any).wallet_amount_cup ?? Math.round(fare * 0.5)).toLocaleString()} del wallet del pasajero`,
                })}
              </Text>
            </View>
          )}
        </View>

        {/* Tip received */}
        {(activeTrip.tip_amount ?? 0) > 0 && (
          <View style={surfaceCard}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons
                  name="gift-outline"
                  size={16}
                  color={midnightEmber.map.text.primary}
                />
                <Text variant="body" style={{ color: midnightEmber.map.text.primary }}>
                  {t('trip.tip_received', {
                    amount: formatTRC(activeTrip.tip_amount!),
                    defaultValue: '¡Recibiste una propina!',
                  })}
                </Text>
              </View>
              <Text
                variant="body"
                style={{ color: midnightEmber.accent[500], fontWeight: '700' }}
              >
                +{formatTRC(activeTrip.tip_amount!)}
              </Text>
            </View>
          </View>
        )}

        {/* Surge indicator */}
        {(activeTrip.surge_multiplier ?? 1) > 1 && (
          <Text
            variant="caption"
            style={{
              color: midnightEmber.map.text.tertiary,
              textAlign: 'center',
              marginBottom: 16,
            }}
          >
            {t('trip.surge_active', {
              multiplier: activeTrip.surge_multiplier,
              defaultValue: `Tarifa dinámica ${activeTrip.surge_multiplier}x activa`,
            })}
          </Text>
        )}

        {/* Receipt download: native-only */}
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
          <View style={{ width: '100%', marginBottom: 12 }}>
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
          <View style={{ width: '100%', marginBottom: 12 }}>
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

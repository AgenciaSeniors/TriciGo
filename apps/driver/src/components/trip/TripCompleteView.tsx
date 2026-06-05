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
  // Receipt-download in-flight flag. Declared here with the other hooks
  // so it sits ABOVE the `if (!activeTrip) return null` guard below —
  // calling useState after an early return violates rules-of-hooks.
  const [downloadingReceipt, setDownloadingReceipt] = useState(false);

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
  // BUG-fare-display-parity: usar `commission_amount` snapshoteado del
  // RPC return (vía driver.completeRide → CompleteRideResult). Antes
  // recalculaba `fare * commissionRate` LIVE, que driftaba con respecto
  // al PDF (que usa snapshot). Si la commission_rate cambió post-completion,
  // hero mostraba un número y PDF otro. Snapshot es la fuente de verdad.
  const snapshotCommission = (activeTrip as { commission_amount?: number | null }).commission_amount;
  const commissionAmount = snapshotCommission != null
    ? snapshotCommission
    : Math.round(fare * commissionRate);
  // Tip: 100% para el driver, suma al neto. Antes se mostraba como banner
  // separado pero la label "Ganancia neta" lo omitía → driver no sabía
  // si "Ganaste $500" incluía o no la propina.
  const tipAmount = activeTrip.tip_amount ?? 0;
  const netEarnings = fare - commissionAmount + tipAmount;
  const isCash = activeTrip.payment_method === 'cash' || activeTrip.payment_method === 'mixed';
  // Viajes en TriciCoin: mostrar los montos con etiqueta TRC (1 TRC = 1 CUP,
  // mismo número) — el conductor cobra en su saldo TriciCoin. Espeja
  // RideCompleteView (showTrc = payment_method === 'tricicoin').
  const isTrc = activeTrip.payment_method === 'tricicoin';
  const fmtMoney = (cup: number) => (isTrc ? formatTRC(cup) : formatCUP(cup));

  // BUG-291: defensive display clamp. If actual_distance_m landed on a
  // garbage value (e.g. corrupt GPS samples summed to thousands of km)
  // and the BD wasn't redeployed yet with the new RPC, we still don't
  // want to flash "24,619.93 km" in the trip summary. Clamp to the
  // chargeable distance: estimated × 1.3 if known, else 100km ceiling.
  const HARD_DISTANCE_CEILING_M = 100_000; // 100 km
  const rawActualM = activeTrip.actual_distance_m ?? 0;
  const estimatedM = activeTrip.estimated_distance_m ?? 0;
  const sanityCapM = estimatedM > 0
    ? Math.min(estimatedM * 1.3, HARD_DISTANCE_CEILING_M)
    : HARD_DISTANCE_CEILING_M;
  const displayDistanceM = Math.min(rawActualM, sanityCapM);
  const distanceWasCapped = rawActualM > sanityCapM;

  const handleDownloadReceipt = async () => {
    if (!activeTrip || downloadingReceipt) return;
    setDownloadingReceipt(true);
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
      } else {
        // Print succeeded but Share is unavailable on this device — let
        // the user know the PDF still exists. Previously this silently
        // did nothing, which the QA team interpreted as "doesn't work".
        Toast.show({
          type: 'info',
          text1: t('trip.receipt_saved', {
            defaultValue: 'Recibo guardado',
          }),
          text2: t('trip.receipt_saved_subtitle', {
            defaultValue: 'Compartir no está disponible en este dispositivo.',
          }),
        });
      }
    } catch (err) {
      // BUG-291: surface failures via Toast instead of console-only.
      // Most common causes in the field:
      //   - Receipt data RPC failed (network / not-yet-completed ride)
      //   - expo-print failed to render the HTML (e.g. base64 image)
      //   - expo-sharing dialog dismissed mid-flow
      // Whatever the cause, the driver was tapping a dead button.
      console.error('[Receipt] generation failed:', err);
      Toast.show({
        type: 'error',
        text1: t('trip.receipt_error', {
          defaultValue: 'No se pudo generar el recibo',
        }),
        text2: t('trip.receipt_error_subtitle', {
          defaultValue: 'Probá de nuevo en un momento.',
        }),
      });
    } finally {
      setDownloadingReceipt(false);
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
              /* BUG-fare-driver-hero-gross: el hero ahora muestra GROSS
                 (tarifa cobrada al cliente), no el NET. El driver y el
                 cliente ven el mismo número, y el breakdown abajo aclara
                 la comisión. El i18n string también cambia: ahora dice
                 "Tarifa del viaje: $X" en lugar de "+$X este viaje". */
              amount: isTrc ? formatTRC(fare) : `$${fare.toLocaleString()}`,
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

        {/* Compressed trip summary — single line.
            BUG-291: shows the clamped distance, not the raw actual_distance_m.
            Without this guard, a corrupt GPS sum (e.g. 24,619 km on a 2 km
            trip) would surface as "24619.9 km" in the summary even though
            the customer was only billed for the capped chargeable portion. */}
        <Text
          variant="bodySmall"
          style={{
            color: midnightEmber.map.text.secondary,
            textAlign: 'center',
            marginBottom: distanceWasCapped ? 4 : 12,
          }}
        >
          {fmtMoney(activeTrip.final_fare_cup ?? activeTrip.estimated_fare_cup)} · {(displayDistanceM / 1000).toFixed(1)} km · {Math.ceil((activeTrip.actual_duration_s || 0) / 60)} min
        </Text>
        {distanceWasCapped && (
          <Text
            variant="caption"
            style={{
              color: midnightEmber.map.text.tertiary,
              textAlign: 'center',
              marginBottom: 12,
            }}
          >
            {t('trip.distance_clamped', {
              defaultValue: 'Distancia ajustada por la app — GPS inconsistente.',
            })}
          </Text>
        )}

        {/* Commission breakdown */}
        <View style={surfaceCard}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text variant="bodySmall" style={{ color: midnightEmber.map.text.secondary }}>
              {t('trip.total_fare', { defaultValue: 'Tarifa total' })}
            </Text>
            <Text variant="bodySmall" style={{ color: midnightEmber.map.text.primary }}>
              {fmtMoney(fare)}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text variant="bodySmall" style={{ color: midnightEmber.map.text.secondary }}>
              {/* BUG-fare-display-parity: % efectivo del snapshot, no
                  hardcoded 15. Útil cuando ride es corporativo (rate ≠ 15) o
                  cuando platform_config cambia globalmente. */}
              {t('trip.platform_commission_pct', {
                defaultValue: 'Comisión plataforma ({{pct}}%)',
                pct: Math.round((commissionAmount / Math.max(fare, 1)) * 100),
              })}
            </Text>
            <Text variant="bodySmall" style={{ color: midnightEmber.state.danger }}>
              {/* BUG-fare-driver-hero-gross: agregar `(= X TC)` para aclarar
                 que la comisión se descuenta del saldo TriciCoin del driver
                 (peg 1:1 con CUP, mismo valor numérico). */}
              -{formatCUP(commissionAmount)} {t('trip.tc_equivalent', { tc: commissionAmount, defaultValue: '(= {{tc}} TC)' })}
            </Text>
          </View>
          {tipAmount > 0 && (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text variant="bodySmall" style={{ color: midnightEmber.state.success }}>
                {t('trip.tip', { defaultValue: 'Propina' })}
              </Text>
              <Text variant="bodySmall" style={{ color: midnightEmber.state.success }}>
                +{fmtMoney(tipAmount)}
              </Text>
            </View>
          )}
          {/* BUG-fare-driver-hero-gross: removido el bloque "Te llevás / Cobras
             en efectivo" + separator anterior. El hero arriba ya muestra el
             GROSS (lo cobrado al cliente) y el breakdown muestra la comisión.
             Mostrar también el NET acá era redundante y confundía. */}
          <Text
            variant="caption"
            style={{ color: midnightEmber.map.text.tertiary, marginTop: 4 }}
          >
            {/* Caption siempre visible (no solo en cash): la comisión SIEMPRE
               se descuenta del saldo TC del driver, independientemente del
               payment_method (confirmado con user 2026-05-24). */}
            {t('trip.commission_deducted', { defaultValue: 'Se descuenta de tu saldo TriciCoin (1 CUP = 1 TC)' })}
          </Text>
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
                  amount: formatCUP(activeTrip.cash_amount_cup ?? Math.round(fare * 0.5)),
                  defaultValue: `Cobrar $${(activeTrip.cash_amount_cup ?? Math.round(fare * 0.5)).toLocaleString()} en efectivo`,
                })}
              </Text>
              <Text
                variant="caption"
                style={{ color: midnightEmber.map.text.tertiary }}
              >
                {t('trip.wallet_portion', {
                  amount: formatCUP(activeTrip.wallet_amount_cup ?? Math.round(fare * 0.5)),
                  defaultValue: `$${(activeTrip.wallet_amount_cup ?? Math.round(fare * 0.5)).toLocaleString()} del wallet del pasajero`,
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
              defaultValue: `Recargo por mal tiempo ${activeTrip.surge_multiplier}x`,
            })}
          </Text>
        )}

        {/* Receipt download: native-only.
            BUG-291: surfaces loading state + error toast (previously silent
            console.error only, so the QA team saw a button that "does
            nothing" when generation failed). */}
        {Platform.OS !== 'web' && (
          <Button
            title={downloadingReceipt
              ? t('trip.downloading_receipt', { defaultValue: 'Generando recibo…' })
              : t('trip.download_receipt', { defaultValue: 'Descargar recibo' })}
            variant="outline"
            size="lg"
            fullWidth
            forceDark
            onPress={handleDownloadReceipt}
            loading={downloadingReceipt}
            disabled={downloadingReceipt}
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

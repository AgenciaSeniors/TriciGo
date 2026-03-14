import React, { useState, useEffect } from 'react';
import { View, Pressable, Share } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { formatTRC, formatCUP, generateReceiptHTML, triggerSelection, trackEvent } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { reviewService } from '@tricigo/api/services/review';
import { rideService, useFeatureFlag } from '@tricigo/api';
import { useRideStore } from '@/stores/ride.store';
import { useAuthStore } from '@/stores/auth.store';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { DriverCard } from '@tricigo/ui/DriverCard';
import { Input } from '@tricigo/ui/Input';
import { Ionicons } from '@expo/vector-icons';
import { RidePaymentPending } from './RidePaymentPending';
import type { RideSplit } from '@tricigo/types';

const RIDER_POSITIVE_TAGS = [
  'clean_vehicle', 'great_conversation', 'expert_navigation', 'smooth_driving', 'went_above_and_beyond',
] as const;
const RIDER_NEGATIVE_TAGS = [
  'dirty_vehicle', 'unsafe_driving', 'rude_behavior', 'wrong_route', 'long_wait',
] as const;

export function RideCompleteView() {
  const { t } = useTranslation('rider');
  const activeRide = useRideStore((s) => s.activeRide);
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);
  const splits = useRideStore((s) => s.splits);
  const resetAll = useRideStore((s) => s.resetAll);
  const userId = useAuthStore((s) => s.user?.id);

  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [tipSent, setTipSent] = useState(false);
  const [sendingTip, setSendingTip] = useState(false);
  const categorizedRatingsEnabled = useFeatureFlag('categorized_ratings_enabled');

  // Reset tags when crossing the positive/negative boundary
  useEffect(() => {
    setSelectedTags([]);
  }, [selectedRating && selectedRating >= 4 ? 'positive' : 'negative']);

  if (!activeRide) return null;

  // If TropiPay payment is pending, show the payment screen instead
  if (activeRide.payment_method === 'tropipay' && activeRide.payment_status === 'pending') {
    return <RidePaymentPending />;
  }

  const fareTrc = activeRide.final_fare_trc ?? activeRide.estimated_fare_trc;
  const fareCup = activeRide.final_fare_cup ?? activeRide.estimated_fare_cup;
  const hasDriver = !!activeRide.driver_id && !!rideWithDriver?.driver_user_id;

  const handleTip = async (amount: number) => {
    if (!userId || !activeRide) return;
    setSendingTip(true);
    try {
      await rideService.addTip(activeRide.id, userId, amount);
      setTipSent(true);
      Toast.show({ type: 'success', text1: t('ride.tip_sent_confirmation') });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('common.error');
      Toast.show({ type: 'error', text1: t('common.error'), text2: msg });
    } finally {
      setSendingTip(false);
    }
  };

  const handleSubmitReview = async () => {
    if (!selectedRating || !userId || !rideWithDriver?.driver_user_id) return;
    setSubmitting(true);
    try {
      await reviewService.submitReview({
        ride_id: activeRide.id,
        reviewer_id: userId,
        reviewee_id: rideWithDriver.driver_user_id,
        rating: selectedRating as 1 | 2 | 3 | 4 | 5,
        comment: comment.trim() || undefined,
        tags: selectedTags.length > 0 ? selectedTags : undefined,
      });
      setSubmitted(true);
      trackEvent('ride_rated', { ride_id: activeRide.id, rating: selectedRating });
      setTimeout(() => resetAll(), 1500);
    } catch (err) {
      console.error('Error submitting review:', err);
      setSubmitting(false);
    }
  };

  const handleDownloadReceipt = async () => {
    if (!activeRide) return;
    const html = generateReceiptHTML({
      rideId: activeRide.id,
      date: activeRide.completed_at ?? activeRide.created_at,
      pickupAddress: activeRide.pickup_address ?? '',
      dropoffAddress: activeRide.dropoff_address ?? '',
      driverName: rideWithDriver?.driver_name ?? null,
      vehiclePlate: rideWithDriver?.vehicle_plate ?? null,
      serviceType: activeRide.service_type,
      paymentMethod: activeRide.payment_method,
      fareCup: activeRide.final_fare_cup ?? activeRide.estimated_fare_cup,
      fareTrc: activeRide.final_fare_trc ?? activeRide.estimated_fare_trc ?? null,
      distanceM: activeRide.actual_distance_m ?? activeRide.estimated_distance_m ?? 0,
      durationS: activeRide.actual_duration_s ?? activeRide.estimated_duration_s ?? 0,
      surgeMultiplier: activeRide.surge_multiplier ?? 1,
      discountCup: activeRide.discount_amount_cup ?? 0,
    });
    try {
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Recibo TriciGo' });
      }
    } catch (err) {
      console.error('Receipt generation failed:', err);
    }
  };

  if (submitted) {
    return (
      <View className="flex-1 pt-8 items-center justify-center">
        <View className="w-20 h-20 rounded-full bg-success items-center justify-center mb-4">
          <Text variant="h1" color="inverse">✓</Text>
        </View>
        <Text variant="h3">{t('ride.review_thanks')}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 pt-8 items-center">
      {/* Success icon */}
      <View className="w-20 h-20 rounded-full bg-success items-center justify-center mb-4">
        <Text variant="h1" color="inverse">✓</Text>
      </View>

      <Text variant="h3" className="mb-2">{t('ride.completed')}</Text>

      {/* Mini driver card */}
      {rideWithDriver?.driver_name && (
        <View className="w-full mb-4">
          <DriverCard
            driverName={rideWithDriver.driver_name}
            driverAvatarUrl={rideWithDriver.driver_avatar_url}
            driverRating={rideWithDriver.driver_rating}
            driverTotalRides={rideWithDriver.driver_total_rides}
            vehicleMake={rideWithDriver.vehicle_make}
            vehicleModel={rideWithDriver.vehicle_model}
            vehicleColor={rideWithDriver.vehicle_color}
            vehiclePlate={rideWithDriver.vehicle_plate}
            vehicleYear={rideWithDriver.vehicle_year}
            compact
            ridesLabel={t('ride.driver_rides_count', { count: rideWithDriver.driver_total_rides ?? 0, defaultValue: '{{count}} viajes' }).replace(/^\d+\s*/, '')}
          />
        </View>
      )}

      {/* Fare */}
      <Text variant="h2" color="accent" className="mb-2" accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: fareTrc != null ? formatTRC(fareTrc) : formatCUP(fareCup) })}>
        {fareTrc != null ? formatTRC(fareTrc) : formatCUP(fareCup)}
      </Text>
      {activeRide.actual_distance_m != null && (
        <View className="flex-row gap-4 mb-2" accessible={true} accessibilityLabel={`${t('a11y.stat_distance', { ns: 'common', value: `${(activeRide.actual_distance_m / 1000).toFixed(1)} km` })}, ${t('a11y.stat_duration', { ns: 'common', value: `${Math.round((activeRide.actual_duration_s ?? 0) / 60)} min` })}`}>
          <Text variant="caption" color="secondary">
            {(activeRide.actual_distance_m / 1000).toFixed(1)} km
          </Text>
          <Text variant="caption" color="secondary">
            {Math.round((activeRide.actual_duration_s ?? 0) / 60)} min
          </Text>
        </View>
      )}
      <Text variant="caption" color="secondary" className="mb-2">
        {activeRide.payment_method === 'cash'
          ? t('ride.paid_cash', { defaultValue: 'Pagado en efectivo' })
          : activeRide.payment_method === 'tropipay'
            ? t('payment.paid_tropipay', { defaultValue: 'Pagado con TropiPay' })
            : t('ride.paid_tricicoin', { defaultValue: 'Pagado con TriciCoin' })}
      </Text>
      {activeRide.discount_amount_cup > 0 && (
        <Text variant="caption" className="mb-4 text-green-600">
          {t('ride.discount_applied', { defaultValue: 'Descuento aplicado' })}: -{formatCUP(activeRide.discount_amount_cup)}
        </Text>
      )}
      {activeRide.discount_amount_cup === 0 && !activeRide.is_split && <View className="mb-4" />}

      {/* Split breakdown */}
      {activeRide.is_split && splits.length > 0 && (
        <Card variant="filled" padding="md" className="w-full mb-4">
          <View className="flex-row items-center mb-2">
            <Ionicons name="people" size={18} color="#888" />
            <Text variant="bodySmall" className="ml-2 font-bold">
              {t('ride.split_fare', { defaultValue: 'Dividir tarifa' })}
            </Text>
          </View>

          {/* Your share */}
          <View className="flex-row justify-between items-center py-1 border-b border-neutral-100">
            <Text variant="bodySmall">
              {t('ride.split_you', { defaultValue: 'Tú' })}
            </Text>
            <Text variant="bodySmall" className="font-bold">
              {formatTRC(
                fareTrc != null
                  ? fareTrc - splits.reduce((sum, s) => sum + (s.amount_trc ?? Math.round(fareTrc * s.share_pct / 100)), 0)
                  : 0
              )}
            </Text>
          </View>

          {/* Each participant */}
          {splits.map((split) => (
            <View key={split.id} className="flex-row justify-between items-center py-1 border-b border-neutral-100">
              <View className="flex-row items-center gap-1">
                <Text variant="bodySmall">
                  {split.user_name || split.user_phone || '...'}
                </Text>
                <Text variant="caption" color={split.payment_status === 'paid' ? 'accent' : 'secondary'}>
                  {split.payment_status === 'paid'
                    ? `✓ ${t('ride.split_paid', { defaultValue: 'Pagado' })}`
                    : split.accepted_at
                      ? t('ride.split_accepted', { defaultValue: 'Aceptado' })
                      : t('ride.split_pending', { defaultValue: 'Pendiente' })}
                </Text>
              </View>
              <Text variant="bodySmall" className="font-bold">
                {split.amount_trc != null
                  ? formatTRC(split.amount_trc)
                  : fareTrc != null
                    ? `~${formatTRC(Math.round(fareTrc * split.share_pct / 100))}`
                    : `${split.share_pct}%`}
              </Text>
            </View>
          ))}
        </Card>
      )}

      {/* Route summary */}
      <Card variant="outlined" padding="md" className="w-full mb-6">
        <RouteSummary
          pickupAddress={activeRide.pickup_address}
          dropoffAddress={activeRide.dropoff_address}
          pickupLabel={t('ride.pickup')}
          dropoffLabel={t('ride.dropoff')}
        />
      </Card>

      {/* Share ride */}
      {activeRide.share_token && (
        <Button
          title={t('ride.share_ride', { defaultValue: 'Compartir viaje' })}
          variant="outline"
          size="md"
          fullWidth
          onPress={() => Share.share({ message: `https://tricigo.app/ride/${activeRide.share_token}` })}
          className="mb-4"
        />
      )}

      {/* Download receipt */}
      <Button
        title={t('ride.download_receipt', { defaultValue: 'Descargar recibo' })}
        variant="outline"
        size="md"
        fullWidth
        onPress={handleDownloadReceipt}
        className="mb-4"
      />

      {/* Tip section */}
      {hasDriver && activeRide.payment_method !== 'cash' && !tipSent && (
        <View className="w-full mb-4">
          <Text variant="bodySmall" color="secondary" className="text-center mb-2">
            {t('ride.tip_title')}
          </Text>
          <View className="flex-row gap-2 justify-center">
            {[5000, 10000, 20000].map((amount) => (
              <Pressable
                key={amount}
                className="px-4 py-2 rounded-full bg-neutral-100"
                onPress={() => handleTip(amount)}
                disabled={sendingTip}
                accessibilityRole="button"
                accessibilityLabel={`${t('ride.tip_title')} ${formatTRC(amount)}`}
              >
                <Text variant="bodySmall">{formatTRC(amount)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {tipSent && (
        <View className="w-full mb-4 items-center" accessibilityLiveRegion="polite">
          <Text variant="bodySmall" className="text-success-dark">{'✓ '}{t('ride.tip_sent_confirmation')}</Text>
        </View>
      )}

      {/* Rating */}
      {hasDriver ? (
        <>
          <View className="flex-row gap-2 mb-2" accessibilityRole="radiogroup" accessibilityLabel={t('ride.rate_driver')}>
            {[1, 2, 3, 4, 5].map((star) => (
              <Pressable
                key={star}
                onPress={() => { setSelectedRating(star); triggerSelection(); }}
                accessibilityRole="radio"
                accessibilityLabel={`${star} ${star === 1 ? 'star' : 'stars'}`}
                accessibilityState={{ selected: selectedRating === star }}
                style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text
                  variant="h3"
                  className={
                    selectedRating && star <= selectedRating
                      ? 'text-yellow-500'
                      : 'text-neutral-300'
                  }
                >
                  ★
                </Text>
              </Pressable>
            ))}
          </View>
          <Text variant="caption" color="tertiary" className="mb-4">
            {t('ride.rate_driver')}
          </Text>

          {/* Tag chips */}
          {categorizedRatingsEnabled && selectedRating && (
            <View className="w-full mb-4">
              <Text variant="bodySmall" color="secondary" className="mb-2">
                {t('ride.rating_tags_title')}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {(selectedRating >= 4 ? RIDER_POSITIVE_TAGS : RIDER_NEGATIVE_TAGS).map((tag) => {
                  const isSelected = selectedTags.includes(tag);
                  return (
                    <Pressable
                      key={tag}
                      onPress={() => {
                        setSelectedTags((prev) =>
                          isSelected ? prev.filter((t) => t !== tag) : [...prev, tag],
                        );
                        triggerSelection();
                      }}
                      className={`px-3 py-1.5 rounded-full border ${
                        isSelected
                          ? 'bg-primary-500/10 border-primary-500'
                          : 'bg-neutral-100 border-neutral-200'
                      }`}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={t(`ride.tag_${tag}`)}
                    >
                      <Text
                        variant="bodySmall"
                        color={isSelected ? 'accent' : 'secondary'}
                      >
                        {t(`ride.tag_${tag}`)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {selectedRating && (
            <View className="w-full">
              <Input
                placeholder={t('ride.your_comment')}
                value={comment}
                onChangeText={setComment}
                multiline
                numberOfLines={3}
                style={{ minHeight: 80 }}
              />
            </View>
          )}

          <Button
            title={selectedRating ? t('ride.submit_review') : t('ride.done', { defaultValue: 'Listo' })}
            size="lg"
            fullWidth
            onPress={selectedRating ? handleSubmitReview : resetAll}
            loading={submitting}
          />
        </>
      ) : (
        <Button
          title={t('ride.done', { defaultValue: 'Listo' })}
          size="lg"
          fullWidth
          onPress={resetAll}
        />
      )}
    </View>
  );
}

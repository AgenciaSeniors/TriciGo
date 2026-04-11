import React, { useState, useEffect, useRef } from 'react';
import { View, Pressable, Share, Animated, useColorScheme, type GestureResponderEvent } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as Notifications from 'expo-notifications';
import Toast from 'react-native-toast-message';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { formatTRC, formatCUP, generateReceiptHTML, triggerSelection, triggerHaptic, trackEvent, getErrorMessage, logger } from '@tricigo/utils';
import { RIDE_CONFIG } from '@/config/ride';
import { useTranslation } from '@tricigo/i18n';
import { reviewService } from '@tricigo/api/services/review';
import { rideService, notificationService, useFeatureFlag, getSupabaseClient } from '@tricigo/api';
import { darkColors } from '@tricigo/theme';
import { useRideStore } from '@/stores/ride.store';
import { useAuthStore } from '@/stores/auth.store';
import { RouteSummary } from '@tricigo/ui/RouteSummary';
import { DriverCard } from '@tricigo/ui/DriverCard';
import { Input } from '@tricigo/ui/Input';
import { Ionicons } from '@expo/vector-icons';
import type { RideSplit } from '@tricigo/types';

// Fallback tags in case DB fetch fails
const FALLBACK_POSITIVE_TAGS = [
  'clean_vehicle', 'great_conversation', 'expert_navigation', 'smooth_driving', 'went_above_and_beyond',
];
const FALLBACK_NEGATIVE_TAGS = [
  'dirty_vehicle', 'unsafe_driving', 'rude_behavior', 'wrong_route', 'long_wait',
];

function AnimatedStar({ filled, onPress, delay = 0 }: { filled: boolean; onPress: () => void; delay?: number }) {
  const scale = useRef(new Animated.Value(1)).current;
  const fillAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (filled) {
      setTimeout(() => {
        Animated.parallel([
          Animated.spring(scale, { toValue: 1.3, friction: 3, useNativeDriver: true }),
          Animated.timing(fillAnim, { toValue: 1, duration: 200, useNativeDriver: false }),
        ]).start(() => {
          Animated.spring(scale, { toValue: 1, friction: 5, useNativeDriver: true }).start();
        });
      }, delay);
    } else {
      fillAnim.setValue(0);
      scale.setValue(1);
    }
  }, [filled]);

  const color = fillAnim.interpolate({ inputRange: [0, 1], outputRange: ['#D1D5DB', '#FBBF24'] });

  return (
    <Pressable
      onPress={onPress}
      style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Animated.Text style={{ fontSize: 32, color }}>★</Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

export function RideCompleteView() {
  const { t } = useTranslation('rider');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const activeRide = useRideStore((s) => s.activeRide);
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);
  const splits = useRideStore((s) => s.splits);
  const addSplit = useRideStore((s) => s.addSplit);
  const updateSplit = useRideStore((s) => s.updateSplit);
  const setSplits = useRideStore((s) => s.setSplits);
  const resetAll = useRideStore((s) => s.resetAll);
  const userId = useAuthStore((s) => s.user?.id);

  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [tipSent, setTipSent] = useState(false);
  const [sendingTip, setSendingTip] = useState(false);
  const [receiptEmailed, setReceiptEmailed] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [isFirstRide, setIsFirstRide] = useState(false);
  const [positiveTags, setPositiveTags] = useState<string[]>(FALLBACK_POSITIVE_TAGS);
  const [negativeTags, setNegativeTags] = useState<string[]>(FALLBACK_NEGATIVE_TAGS);
  const categorizedRatingsEnabled = useFeatureFlag('categorized_ratings_enabled');
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const tipScaleAnim = useRef(new Animated.Value(1)).current;
  const router = useRouter();

  // Fetch dynamic tag definitions from DB
  useEffect(() => {
    Promise.all([
      reviewService.getTagDefinitions('rider_to_driver', 'positive'),
      reviewService.getTagDefinitions('rider_to_driver', 'negative'),
    ]).then(([pos, neg]) => {
      if (pos.length > 0) setPositiveTags(pos.map((t) => t.key));
      if (neg.length > 0) setNegativeTags(neg.map((t) => t.key));
    }).catch(() => { /* use fallback tags */ });
  }, []);

  // U3.1: Check if this is the user's first completed ride
  useEffect(() => {
    if (userId) {
      rideService.getRideHistory(userId, { page: 0, pageSize: 1 }).then((rides) => {
        // If only 1 ride (this one), it's their first
        setIsFirstRide(rides.length <= 1);
      }).catch(() => {});
    }
  }, [userId]);

  // Subscribe to real-time split updates (payment confirmations post-ride)
  useEffect(() => {
    if (!activeRide?.id || !activeRide.is_split) return;

    // Fetch current splits state
    rideService.getSplitsForRide(activeRide.id)
      .then((existingSplits) => setSplits(existingSplits))
      .catch(() => {});

    const channel = rideService.subscribeToSplits(
      activeRide.id,
      (newSplit) => addSplit(newSplit),
      (updatedSplit) => updateSplit(updatedSplit),
    );

    return () => {
      const supabase = getSupabaseClient();
      supabase.removeChannel(channel);
    };
  }, [activeRide?.id, activeRide?.is_split]);

  // UBER-4.1: When rating changes, pre-select first tag of the appropriate category
  const ratingCategory = selectedRating ? (selectedRating >= 4 ? 'positive' : 'negative') : null;
  useEffect(() => {
    if (selectedRating && selectedRating >= 4 && positiveTags.length > 0) {
      setSelectedTags([positiveTags[0]]);
    } else if (selectedRating && selectedRating <= 3 && negativeTags.length > 0) {
      setSelectedTags([negativeTags[0]]);
    } else {
      setSelectedTags([]);
    }
  }, [ratingCategory]);

  if (!activeRide) return null;

  const fareTrc = activeRide.final_fare_trc ?? activeRide.estimated_fare_trc;
  const fareCup = activeRide.final_fare_cup ?? activeRide.estimated_fare_cup;
  const showTrc = activeRide.payment_method === 'tricicoin';
  const fareDisplay = showTrc && fareTrc != null ? formatTRC(fareTrc) : formatCUP(fareCup);
  const hasDriver = !!activeRide.driver_id && !!rideWithDriver?.driver_user_id;

  const handleTip = async (amount: number) => {
    if (!userId || !activeRide) return;
    // X2.5: Validate tip amount
    if (amount <= 0 || amount > RIDE_CONFIG.MAX_TIP_AMOUNT) {
      Toast.show({ type: 'error', text1: t('errors.invalid_tip', { ns: 'common', defaultValue: 'Monto de propina inválido' }) });
      return;
    }
    setSendingTip(true);
    try {
      await rideService.addTip(activeRide.id, userId, amount);
      setTipSent(true);
      triggerHaptic('success');
      // U3.3: Tip thank-you animation (shrink → grow → settle)
      Animated.sequence([
        Animated.spring(tipScaleAnim, { toValue: 0.9, friction: 5, useNativeDriver: true }),
        Animated.spring(tipScaleAnim, { toValue: 1.1, friction: 5, useNativeDriver: true }),
        Animated.spring(tipScaleAnim, { toValue: 1, friction: 5, useNativeDriver: true }),
      ]).start();
      Toast.show({ type: 'success', text1: t('ride.tip_sent_confirmation') });
    } catch (err) {
      Toast.show({ type: 'error', text1: t('common.error'), text2: getErrorMessage(err) });
    } finally {
      setSendingTip(false);
    }
  };

  const handleSubmitReview = async () => {
    if (hasSubmitted) return;
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
      setHasSubmitted(true);
      setSubmitted(true);
      triggerHaptic('success');
      trackEvent('ride_rated', { ride_id: activeRide.id, rating: selectedRating });

      // F009: Clear pending review — review submitted successfully
      AsyncStorage.removeItem('@tricigo/pending_review_ride_id').catch(() => {});

      // Cancel rating reminder if it was scheduled
      const reminderId = useRideStore.getState().ratingReminderId;
      if (reminderId) {
        Notifications.cancelScheduledNotificationAsync(reminderId).catch(() => {});
        useRideStore.getState().setRatingReminderId(null);
      }
      setTimeout(() => resetAll(), 5000);
    } catch (err) {
      logger.error('Error submitting review', { error: String(err) });
      Toast.show({ type: 'error', text1: t('errors.review_submit_failed', { ns: 'common' }) });
      // BUG-069: Clear rating reminder on review submission error to avoid stale notifications
      const reminderId = useRideStore.getState().ratingReminderId;
      if (reminderId) {
        Notifications.cancelScheduledNotificationAsync(reminderId).catch(() => {});
        useRideStore.getState().setRatingReminderId(null);
      }
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
      paymentMethod: activeRide.payment_method === 'corporate'
        ? t('payment.paid_corporate', { defaultValue: 'Cuenta corporativa' })
        : activeRide.payment_method,
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
      logger.error('Receipt generation failed', { error: String(err) });
    }
  };

  const handleEmailReceipt = async () => {
    if (!activeRide || !userId) return;
    setSendingEmail(true);
    try {
      await notificationService.sendRideReceipt(activeRide.id, userId);
      setReceiptEmailed(true);
      Toast.show({ type: 'success', text1: t('ride.receipt_emailed', { defaultValue: 'Recibo enviado a tu email' }) });
    } catch {
      Toast.show({ type: 'error', text1: t('common.error'), text2: t('ride.receipt_email_failed', { defaultValue: 'No se pudo enviar el recibo' }) });
    } finally {
      setSendingEmail(false);
    }
  };

  useEffect(() => {
    if (submitted) {
      // U3.1: Bigger bounce for first ride
      if (isFirstRide) scaleAnim.setValue(0.5);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.spring(scaleAnim, { toValue: 1, friction: 4, tension: 40, useNativeDriver: true }),
      ]).start();
    }
  }, [submitted, fadeAnim, scaleAnim, isFirstRide]);

  if (submitted) {
    return (
      <Animated.View style={{ flex: 1, paddingTop: 32, alignItems: 'center', justifyContent: 'center', opacity: fadeAnim, transform: [{ scale: scaleAnim }] }}>
        <View className={`${isFirstRide ? 'w-24 h-24' : 'w-20 h-20'} rounded-full bg-success items-center justify-center mb-4`}>
          <Text variant="h1" color="inverse">✓</Text>
        </View>
        <Text variant="h3">{isFirstRide ? t('ride.first_ride_title') : t('ride.review_thanks')}</Text>
        {isFirstRide && (
          <Pressable onPress={() => router.push('/profile/referral')} className="mt-3">
            <Text variant="bodySmall" color="accent">{t('ride.invite_friends')} →</Text>
          </Pressable>
        )}
        <Button
          title={t('ride.done', { defaultValue: 'Listo' })}
          size="lg"
          variant="outline"
          onPress={() => resetAll()}
          style={{ marginTop: 16 }}
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 pt-8 items-center">
      {/* Success icon — U3.1: larger for first ride */}
      <View className={`${isFirstRide ? 'w-24 h-24' : 'w-20 h-20'} rounded-full bg-success items-center justify-center mb-4`}>
        <Text variant="h1" color="inverse">✓</Text>
      </View>

      <Text variant="h3" className="mb-2">{isFirstRide ? t('ride.first_ride_title') : t('ride.completed')}</Text>
      {isFirstRide && (
        <Pressable onPress={() => router.push('/profile/referral')} className="mb-2">
          <Text variant="bodySmall" color="accent">{t('ride.invite_friends')} →</Text>
        </Pressable>
      )}

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
      <Text variant="h2" color="accent" className="mb-2" accessibilityLabel={t('a11y.fare_amount', { ns: 'common', amount: fareDisplay })}>
        {fareDisplay}
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
          : activeRide.payment_method === 'corporate'
            ? t('payment.paid_corporate', { defaultValue: 'Cobrado a cuenta corporativa' })
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
            <Ionicons name="people" size={18} color={isDark ? darkColors.text.secondary : '#888888'} />
            <Text variant="bodySmall" className="ml-2 font-bold">
              {t('ride.split_fare', { defaultValue: 'Dividir tarifa' })}
            </Text>
          </View>

          {/* Your share */}
          <View className="flex-row justify-between items-center py-1 border-b border-neutral-100 dark:border-neutral-800">
            <Text variant="bodySmall">
              {t('ride.split_you', { defaultValue: 'Tú' })}
            </Text>
            <Text variant="bodySmall" className="font-bold">
              {formatTRC(
                fareTrc != null
                  ? Math.round(fareTrc - splits.reduce((sum, s) => sum + (s.amount_trc ?? Math.round(fareTrc * s.share_pct / 100)), 0))
                  : 0
              )}
            </Text>
          </View>

          {/* Each participant */}
          {splits.map((split) => (
            <View key={split.id} className="flex-row justify-between items-center py-1 border-b border-neutral-100 dark:border-neutral-800">
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
          onPress={() => Share.share({ message: `https://tricigo.com/ride/${activeRide.share_token}` })}
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
        className="mb-2"
      />

      {/* Email receipt */}
      {!receiptEmailed ? (
        <Button
          title={t('ride.email_receipt', { defaultValue: 'Enviar recibo por email' })}
          variant="ghost"
          size="md"
          fullWidth
          loading={sendingEmail}
          disabled={sendingEmail}
          onPress={handleEmailReceipt}
          className="mb-4"
        />
      ) : (
        <View className="mb-4 items-center" accessibilityLiveRegion="polite">
          <Text variant="bodySmall" className="text-success-dark">
            {'✓ '}{t('ride.receipt_emailed', { defaultValue: 'Recibo enviado a tu email' })}
          </Text>
        </View>
      )}

      {/* Rating + Tip */}
      {hasDriver ? (
        <>
          {/* U3.2: Stars with cascade fill animation */}
          <View className="flex-row gap-2 mb-2" accessibilityRole="radiogroup" accessibilityLabel={t('ride.rate_driver')}>
            {[1, 2, 3, 4, 5].map((star, index) => (
              <AnimatedStar
                key={star}
                filled={!!selectedRating && star <= selectedRating}
                onPress={() => { setSelectedRating(star); triggerSelection(); }}
                delay={index * 80}
              />
            ))}
          </View>
          <Text variant="caption" color="tertiary" className="mb-2">
            {t('ride.rate_driver')}
          </Text>

          {/* Skip rating */}
          <Pressable onPress={resetAll} className="mb-4" accessibilityRole="button" accessibilityLabel={t('ride.skip_rating')}>
            <Text variant="bodySmall" color="tertiary" className="text-center mt-2">{t('ride.skip_rating')}</Text>
          </Pressable>

          {/* Tip section (alongside rating) */}
          {activeRide.payment_method !== 'cash' && !tipSent && (
            <View className="w-full mb-4">
              <Text variant="bodySmall" color="secondary" className="text-center mb-2">
                {t('ride.tip_title')}
              </Text>
              <View className="flex-row gap-2 justify-center">
                {[5000, 10000, 20000].map((amount) => (
                  <Pressable
                    key={amount}
                    className="px-4 py-2 rounded-full bg-neutral-100 dark:bg-neutral-800"
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
          {/* U3.3: Tip thank-you animated badge */}
          {tipSent && (
            <Animated.View style={{ transform: [{ scale: tipScaleAnim }] }} className="w-full mb-4 items-center" accessibilityLiveRegion="polite">
              <View className="px-4 py-2 rounded-full bg-success/10 flex-row items-center gap-2">
                <Ionicons name="checkmark-circle" size={18} color="#16a34a" />
                <Text variant="bodySmall" className="text-success-dark font-semibold">{t('ride.thanks_tip')}</Text>
              </View>
            </Animated.View>
          )}

          {/* Tag chips */}
          {categorizedRatingsEnabled && selectedRating && (
            <View className="w-full mb-4">
              <Text variant="bodySmall" color="secondary" className="mb-2">
                {t('ride.rating_tags_title')}
              </Text>
              <View className="flex-row flex-wrap gap-2">
                {(selectedRating >= 4 ? positiveTags : negativeTags).slice(0, 3).map((tag) => {
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
                          : 'bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700'
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
                maxLength={500}
                style={{ minHeight: 80 }}
              />
              <Text variant="caption" color="tertiary" className="text-right mt-1">
                {comment.length}/500
              </Text>
            </View>
          )}

          <Button
            title={selectedRating ? t('ride.submit_review') : t('ride.done', { defaultValue: 'Listo' })}
            size="lg"
            fullWidth
            onPress={selectedRating ? handleSubmitReview : resetAll}
            loading={submitting}
            disabled={hasSubmitted || submitting}
            accessibilityHint={selectedRating ? 'Enviar calificación al conductor' : undefined}
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

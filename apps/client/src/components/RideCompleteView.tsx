import React, { useState } from 'react';
import { View, Pressable, TextInput, Share, Alert } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { formatCUP } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { reviewService } from '@tricigo/api/services/review';
import { rideService } from '@tricigo/api';
import { useRideStore } from '@/stores/ride.store';
import { useAuthStore } from '@/stores/auth.store';

export function RideCompleteView() {
  const { t } = useTranslation('rider');
  const activeRide = useRideStore((s) => s.activeRide);
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);
  const resetAll = useRideStore((s) => s.resetAll);
  const userId = useAuthStore((s) => s.user?.id);

  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [tipSent, setTipSent] = useState(false);
  const [sendingTip, setSendingTip] = useState(false);

  if (!activeRide) return null;

  const fare = activeRide.final_fare_cup ?? activeRide.estimated_fare_cup;
  const hasDriver = !!activeRide.driver_id && !!rideWithDriver?.driver_user_id;

  const handleTip = async (amount: number) => {
    if (!userId || !activeRide) return;
    setSendingTip(true);
    try {
      await rideService.addTip(activeRide.id, userId, amount);
      setTipSent(true);
      Alert.alert(t('ride.tip_sent', { amount: formatCUP(amount) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error';
      Alert.alert('Error', msg);
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
      });
      setSubmitted(true);
      setTimeout(() => resetAll(), 1500);
    } catch (err) {
      console.error('Error submitting review:', err);
      setSubmitting(false);
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

      {/* Fare */}
      <Text variant="h2" color="accent" className="mb-2">{formatCUP(fare)}</Text>
      {activeRide.actual_distance_m != null && (
        <View className="flex-row gap-4 mb-2">
          <Text variant="caption" color="secondary">
            {(activeRide.actual_distance_m / 1000).toFixed(1)} km
          </Text>
          <Text variant="caption" color="secondary">
            {Math.round((activeRide.actual_duration_s ?? 0) / 60)} min
          </Text>
        </View>
      )}
      <Text variant="caption" color="secondary" className="mb-2">
        {activeRide.payment_method === 'cash' ? t('ride.paid_cash', { defaultValue: 'Pagado en efectivo' }) : t('ride.paid_tricicoin', { defaultValue: 'Pagado con TriciCoin' })}
      </Text>
      {activeRide.discount_amount_cup > 0 && (
        <Text variant="caption" className="mb-4 text-green-600">
          {t('ride.discount_applied', { defaultValue: 'Descuento aplicado' })}: -{formatCUP(activeRide.discount_amount_cup)}
        </Text>
      )}
      {activeRide.discount_amount_cup === 0 && <View className="mb-4" />}

      {/* Route summary */}
      <Card variant="outlined" padding="md" className="w-full mb-6">
        <View className="flex-row items-start mb-3">
          <View className="w-3 h-3 rounded-full bg-primary-500 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="secondary">{t('ride.pickup')}</Text>
            <Text variant="bodySmall">{activeRide.pickup_address}</Text>
          </View>
        </View>
        <View className="flex-row items-start">
          <View className="w-3 h-3 rounded-full bg-neutral-800 mt-1 mr-3" />
          <View className="flex-1">
            <Text variant="caption" color="secondary">{t('ride.dropoff')}</Text>
            <Text variant="bodySmall">{activeRide.dropoff_address}</Text>
          </View>
        </View>
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
              >
                <Text variant="bodySmall">{formatCUP(amount)}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {tipSent && (
        <View className="w-full mb-4 items-center">
          <Text variant="bodySmall" className="text-green-600">✓ Propina enviada</Text>
        </View>
      )}

      {/* Rating */}
      {hasDriver ? (
        <>
          <View className="flex-row gap-2 mb-2">
            {[1, 2, 3, 4, 5].map((star) => (
              <Pressable key={star} onPress={() => setSelectedRating(star)}>
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

          {selectedRating && (
            <TextInput
              className="w-full border border-neutral-200 rounded-lg p-3 mb-4 text-neutral-900"
              placeholder={t('ride.your_comment')}
              value={comment}
              onChangeText={setComment}
              multiline
              numberOfLines={3}
              style={{ textAlignVertical: 'top', minHeight: 80 }}
            />
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

import React, { useState, useEffect } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@tricigo/ui/Text';
import { Button } from '@tricigo/ui/Button';
import { Input } from '@tricigo/ui/Input';
import { Avatar } from '@tricigo/ui/Avatar';
import { Card } from '@tricigo/ui/Card';
import { triggerSelection, trackEvent } from '@tricigo/utils';
import { useTranslation } from '@tricigo/i18n';
import { reviewService, useFeatureFlag } from '@tricigo/api';

// Fallback tags in case DB fetch fails
const FALLBACK_POSITIVE_TAGS = [
  'respectful', 'good_conversation', 'on_time_pickup', 'pleasant_ride',
];
const FALLBACK_NEGATIVE_TAGS = [
  'rude', 'left_mess', 'late_pickup', 'unsafe_behavior', 'bad_directions',
];

interface RiderRatingSheetProps {
  rideId: string;
  reviewerId: string;
  riderId: string;
  riderName: string;
  riderAvatarUrl: string | null;
  onComplete: () => void;
  onSkip: () => void;
}

export function RiderRatingSheet({
  rideId,
  reviewerId,
  riderId,
  riderName,
  riderAvatarUrl,
  onComplete,
  onSkip,
}: RiderRatingSheetProps) {
  const { t } = useTranslation('driver');
  const [selectedRating, setSelectedRating] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [positiveTags, setPositiveTags] = useState<string[]>(FALLBACK_POSITIVE_TAGS);
  const [negativeTags, setNegativeTags] = useState<string[]>(FALLBACK_NEGATIVE_TAGS);
  const categorizedRatingsEnabled = useFeatureFlag('categorized_ratings_enabled');

  // Fetch dynamic tag definitions from DB
  useEffect(() => {
    const fetchTags = () => Promise.all([
      reviewService.getTagDefinitions('driver_to_rider', 'positive'),
      reviewService.getTagDefinitions('driver_to_rider', 'negative'),
    ]).then(([pos, neg]) => {
      if (pos.length > 0) setPositiveTags(pos.map((t) => t.key));
      if (neg.length > 0) setNegativeTags(neg.map((t) => t.key));
    });
    fetchTags().catch(() => {
      // Retry once after 2s
      setTimeout(() => fetchTags().catch(() => { /* use fallback tags */ }), 2000);
    });
  }, []);

  // Reset tags when crossing the positive/negative boundary
  useEffect(() => {
    setSelectedTags([]);
  }, [selectedRating && selectedRating >= 4 ? 'positive' : 'negative']);

  const handleSubmit = async () => {
    if (!selectedRating) return;
    setSubmitting(true);
    try {
      await reviewService.submitReview({
        ride_id: rideId,
        reviewer_id: reviewerId,
        reviewee_id: riderId,
        rating: selectedRating as 1 | 2 | 3 | 4 | 5,
        comment: comment.trim() || undefined,
        tags: selectedTags.length > 0 ? selectedTags : undefined,
      });
      setSubmitted(true);
      trackEvent('rider_rated', { ride_id: rideId, rating: selectedRating });
      setTimeout(() => onComplete(), 1200);
    } catch (err) {
      console.error('Error submitting rider review:', err);
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <View className="items-center py-8">
        <View className="w-16 h-16 rounded-full bg-success items-center justify-center mb-3">
          <Text variant="h2" color="inverse">✓</Text>
        </View>
        <Text variant="body" color="inverse">
          {t('ride.review_thanks', { defaultValue: '¡Gracias por tu calificación!' })}
        </Text>
      </View>
    );
  }

  return (
    <Card forceDark variant="filled" padding="md" className="w-full bg-neutral-800">
      {/* Rider avatar + name */}
      <View className="items-center mb-4">
        <Avatar uri={riderAvatarUrl} size={64} name={riderName} />
        <Text variant="body" color="inverse" className="mt-2 font-semibold">
          {riderName}
        </Text>
        <Text variant="caption" color="inverse" className="opacity-50 mt-1">
          {t('ride.rate_rider_subtitle', { defaultValue: '¿Cómo fue tu experiencia con este pasajero?' })}
        </Text>
      </View>

      {/* Star rating */}
      <View
        className="flex-row gap-2 justify-center mb-3"
        accessibilityRole="radiogroup"
        accessibilityLabel={t('ride.rate_rider', { defaultValue: 'Califica al pasajero' })}
      >
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
                  : 'text-neutral-500'
              }
            >
              ★
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Tag chips */}
      {categorizedRatingsEnabled && selectedRating && (
        <View className="mb-3">
          <Text variant="bodySmall" color="inverse" className="mb-2 opacity-70">
            {t('ride.rating_tags_title')}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {(selectedRating >= 4 ? positiveTags : negativeTags).map((tag) => {
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
                      ? 'bg-primary-500/20 border-primary-400'
                      : 'bg-neutral-700 border-neutral-600'
                  }`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={t(`ride.tag_${tag}`)}
                >
                  <Text
                    variant="bodySmall"
                    color={isSelected ? 'accent' : 'inverse'}
                  >
                    {t(`ride.tag_${tag}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {/* Optional comment */}
      {selectedRating && (
        <View className="mb-3">
          <Input
            placeholder={t('ride.your_comment', { defaultValue: 'Comentario (opcional)' })}
            value={comment}
            onChangeText={setComment}
            multiline
            numberOfLines={2}
            style={{ minHeight: 60 }}
            variant="dark"
          />
        </View>
      )}

      {/* Buttons */}
      <View className="gap-2">
        {selectedRating && (
          <Button
            title={t('ride.submit_review', { defaultValue: 'Enviar calificación' })}
            size="lg"
            fullWidth
            onPress={handleSubmit}
            loading={submitting}
          />
        )}
        <Button
          title={t('ride.skip_rating', { defaultValue: 'Omitir' })}
          variant="outline"
          size="md"
          fullWidth
          forceDark
          onPress={onSkip}
        />
      </View>
    </Card>
  );
}

import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, RefreshControl } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { reviewService } from '@tricigo/api/services/review';
import { useAuthStore } from '@/stores/auth.store';
import { colors } from '@tricigo/theme';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { Review } from '@tricigo/types';

const PAGE_SIZE = 20;

function StarRow({ rating }: { rating: number }) {
  return (
    <View className="flex-row">
      {[1, 2, 3, 4, 5].map((star) => (
        <Text
          key={star}
          variant="body"
          style={{ color: star <= rating ? '#EAB308' : colors.neutral[600] }}
        >
          ★
        </Text>
      ))}
    </View>
  );
}

export default function DriverReviewsScreen() {
  const { t } = useTranslation('driver');
  const userId = useAuthStore((s) => s.user?.id);

  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [summary, setSummary] = useState<{
    average_rating: number;
    total_reviews: number;
    rating_distribution: Record<number, number>;
  } | null>(null);

  const fetchReviews = useCallback(async (pageNum: number, reset = false) => {
    if (!userId) return;
    try {
      const data = await reviewService.getReviewsForUser(userId, pageNum, PAGE_SIZE);
      if (reset) {
        setReviews(data);
      } else {
        setReviews((prev) => [...prev, ...data]);
      }
      setHasMore(data.length === PAGE_SIZE);
      setPage(pageNum);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    // Load summary + first page
    reviewService.getReviewSummary(userId).then(setSummary).catch(() => {});
    fetchReviews(0, true);
  }, [userId, fetchReviews]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    if (userId) {
      reviewService.getReviewSummary(userId).then(setSummary).catch(() => {});
    }
    fetchReviews(0, true);
  }, [fetchReviews, userId]);

  const onEndReached = useCallback(() => {
    if (!hasMore || loading) return;
    fetchReviews(page + 1);
  }, [hasMore, loading, page, fetchReviews]);

  const renderReview = ({ item }: { item: Review }) => (
    <Card forceDark variant="filled" padding="md" className="mb-2 bg-neutral-800">
      <View className="flex-row items-center justify-between mb-1">
        <StarRow rating={item.rating} />
        <Text variant="caption" color="inverse" className="opacity-50">
          {new Date(item.created_at).toLocaleDateString('es-CU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </Text>
      </View>
      {item.comment && (
        <Text variant="bodySmall" color="inverse" className="mt-1 opacity-80">
          "{item.comment}"
        </Text>
      )}
      {item.tags && item.tags.length > 0 && (
        <View className="flex-row flex-wrap gap-1 mt-2">
          {item.tags.map((tag) => (
            <View key={tag} className="px-2 py-0.5 rounded-full bg-neutral-700">
              <Text variant="caption" color="inverse" className="text-[10px] opacity-70">
                {t(`review.tag_${tag}`, { defaultValue: tag.replace(/_/g, ' ') })}
              </Text>
            </View>
          ))}
        </View>
      )}
    </Card>
  );

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); fetchReviews(0, true); }} />;

  return (
    <Screen bg="dark" statusBarStyle="light-content">
      <View className="pt-4 px-5 flex-1">
        <ScreenHeader
          title={t('reviews.title', { defaultValue: 'Mis Reseñas' })}
          onBack={() => router.back()}
          light
        />

        {/* Summary header */}
        {summary && (
          <Card forceDark variant="filled" padding="lg" className="bg-neutral-800 mb-4 mt-2">
            <View className="flex-row items-center justify-between">
              <View className="items-center">
                <Text variant="h1" color="inverse" className="font-bold">
                  {summary.average_rating.toFixed(1)}
                </Text>
                <StarRow rating={Math.round(summary.average_rating)} />
                <Text variant="caption" color="inverse" className="opacity-50 mt-1">
                  {t('reviews.total_count', { defaultValue: '{{count}} reseñas', count: summary.total_reviews })}
                </Text>
              </View>

              {/* Distribution bars */}
              <View className="flex-1 ml-6">
                {[5, 4, 3, 2, 1].map((star) => {
                  const count = summary.rating_distribution[star] ?? 0;
                  const pct = summary.total_reviews > 0 ? (count / summary.total_reviews) * 100 : 0;
                  return (
                    <View key={star} className="flex-row items-center mb-1">
                      <Text variant="caption" color="inverse" className="w-3 opacity-50">{star}</Text>
                      <View className="flex-1 h-2 bg-neutral-700 rounded-full mx-2 overflow-hidden">
                        <View
                          className="h-full rounded-full"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: star >= 4 ? '#22c55e' : star === 3 ? '#EAB308' : '#EF4444',
                          }}
                        />
                      </View>
                      <Text variant="caption" color="inverse" className="w-6 text-right opacity-50">
                        {count}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          </Card>
        )}

        {/* Reviews list */}
        <FlatList
          data={reviews}
          keyExtractor={(item) => item.id}
          renderItem={renderReview}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />
          }
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListEmptyComponent={
            !loading ? (
              <View className="items-center py-12">
                <Text variant="body" color="inverse" className="opacity-30">
                  {t('reviews.no_reviews', { defaultValue: 'Aún no tienes reseñas' })}
                </Text>
              </View>
            ) : null
          }
        />
      </View>
    </Screen>
  );
}

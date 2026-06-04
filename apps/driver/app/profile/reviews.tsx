import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, RefreshControl, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { ScreenHeader } from '@tricigo/ui/ScreenHeader';
import { useTranslation } from '@tricigo/i18n';
import { reviewService } from '@tricigo/api/services/review';
import { useAuthStore } from '@/stores/auth.store';
import { cubanLight, cubanDark, colors } from '@tricigo/theme';
import { ErrorState } from '@tricigo/ui/ErrorState';
import type { Review, ReviewTagSummaryItem } from '@tricigo/types';
import { ReviewTagsBreakdown } from '@/components/profile/ReviewTagsBreakdown';

const PAGE_SIZE = 20;

function StarRow({ rating, palette }: { rating: number; palette: typeof cubanLight | typeof cubanDark }) {
  return (
    <View className="flex-row">
      {[1, 2, 3, 4, 5].map((star) => (
        <Text
          key={star}
          variant="body"
          style={{ color: star <= rating ? '#FBBF24' : palette.ink.subtle }}
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

  // Cuban palette
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const palette = isDark ? cubanDark : cubanLight;
  const CARD_SHADOW = {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: isDark ? 0.4 : 0.06,
    shadowRadius: 8,
    elevation: 2,
  };

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
    top_tags?: ReviewTagSummaryItem[];
  } | null>(null);

  const fetchReviews = useCallback(async (pageNum: number, reset = false) => {
    if (!userId) return;
    try {
      const data = await reviewService.getReviewsForUser(userId, pageNum, PAGE_SIZE);
      if (reset) {
        setReviews(data);
      } else {
        setReviews((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...data.filter((r) => !seen.has(r.id))];
        });
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
    <View style={{ backgroundColor: palette.bg.elev1, borderRadius: 14, padding: 14, marginBottom: 8, ...CARD_SHADOW }}>
      <View className="flex-row items-center justify-between mb-1">
        <StarRow rating={item.rating} palette={palette} />
        <Text style={{ fontSize: 11, color: palette.ink.subtle }}>
          {new Date(item.created_at).toLocaleDateString('es-CU', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </Text>
      </View>
      {item.comment && (
        <Text style={{ fontSize: 13, color: palette.ink.primary, marginTop: 4, lineHeight: 18 }}>
          "{item.comment}"
        </Text>
      )}
      {item.tags && item.tags.length > 0 && (
        <View className="flex-row flex-wrap gap-1 mt-2">
          {item.tags.map((tag) => (
            <View key={tag} style={{ backgroundColor: palette.bg.elev2, borderRadius: 9999, paddingHorizontal: 8, paddingVertical: 2 }}>
              <Text style={{ fontSize: 10, color: palette.ink.secondary, fontWeight: '600' }}>
                {t(`ride.tag_${tag}`, { defaultValue: tag.replace(/_/g, ' ') })}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );

  if (error) return <ErrorState title="Error" description={error} onRetry={() => { setError(null); fetchReviews(0, true); }} />;

  return (
    <Screen bg={isDark ? 'dark' : 'white'} statusBarStyle={isDark ? 'light-content' : 'dark-content'}>
      <View style={{ flex: 1, backgroundColor: palette.bg.paper }} className="pt-4 px-5">
        <ScreenHeader
          title={t('reviews.title', { defaultValue: 'Mis Reseñas' })}
          onBack={() => router.back()}
        />

        {/* Summary header */}
        {summary && (
          <View style={{ backgroundColor: palette.bg.elev1, borderRadius: 16, padding: 18, marginTop: 8, marginBottom: 16, ...CARD_SHADOW }}>
            <View className="flex-row items-center justify-between">
              <View className="items-center">
                <Text style={{ fontFamily: 'Inter_800ExtraBold', fontSize: 36, color: palette.ink.primary, fontVariant: ['tabular-nums'] }}>
                  {summary.average_rating.toFixed(1)}
                </Text>
                <StarRow rating={Math.round(summary.average_rating)} palette={palette} />
                <Text style={{ fontSize: 11, color: palette.ink.subtle, marginTop: 4 }}>
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
                      <Text style={{ width: 12, color: palette.ink.subtle, fontSize: 11 }}>{star}</Text>
                      <View style={{ flex: 1, height: 8, borderRadius: 4, marginHorizontal: 8, overflow: 'hidden', backgroundColor: palette.line }}>
                        <View
                          style={{
                            height: '100%',
                            borderRadius: 4,
                            width: `${pct}%`,
                            backgroundColor: star >= 4 ? '#22C55E' : star === 3 ? '#F59E0B' : '#EF4444',
                          }}
                        />
                      </View>
                      <Text style={{ width: 24, textAlign: 'right', color: palette.ink.subtle, fontSize: 11, fontVariant: ['tabular-nums'] }}>
                        {count}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          </View>
        )}

        {/* N4: Tag breakdown */}
        <ReviewTagsBreakdown topTags={summary?.top_tags} />

        {/* Reviews list */}
        <FlatList
          data={reviews}
          keyExtractor={(item) => item.id}
          renderItem={renderReview}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand.orange} />
          }
          onEndReached={onEndReached}
          onEndReachedThreshold={0.3}
          ListEmptyComponent={
            !loading ? (
              <View className="items-center py-12">
                <Text style={{ color: palette.ink.subtle }}>
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

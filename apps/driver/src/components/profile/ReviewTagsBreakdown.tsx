/**
 * ReviewTagsBreakdown — Phase 2 N4.
 *
 * Splits the driver's top received tags into positive vs negative
 * buckets and renders them as compact chip rails so the driver knows
 * what to keep doing and what to fix without scrolling through every
 * single review.
 *
 * Inputs:
 *   - `topTags`: ranked array of `{ tag_key, count }` from
 *     `reviewService.getReviewSummary` (RPC `get_review_tag_summary`,
 *     migration 00043).
 *
 * Sentiment is determined client-side by joining `topTags` against
 * the `review_tag_definitions` table filtered to direction
 * `rider_to_driver` (driver receives reviews from riders) and
 * sentiment `positive` / `negative`. We fetch those once on mount and
 * cache them in component state.
 *
 * Tag labels come from i18n keys following the pattern
 * `ride.tag_<key>` in the `driver` namespace — the same keys the
 * `reviews.tsx` screen uses, so adding new tags doesn't need a code change here.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@tricigo/ui/Text';
import { useTranslation } from '@tricigo/i18n';
import { reviewService } from '@tricigo/api';
import { midnightEmber } from '@tricigo/theme';
import type { ReviewTagSummaryItem, ReviewTagDefinition } from '@tricigo/types';

interface ReviewTagsBreakdownProps {
  topTags: ReviewTagSummaryItem[] | undefined;
}

/** Append `33` (≈20% alpha) to a hex color. */
function tinted(color: string): string {
  return `${color}33`;
}

interface ResolvedTag {
  key: string;
  count: number;
  sentiment: 'positive' | 'negative';
}

export function ReviewTagsBreakdown({ topTags }: ReviewTagsBreakdownProps) {
  const { t } = useTranslation('common');
  const [positiveDefs, setPositiveDefs] = useState<ReviewTagDefinition[] | null>(null);
  const [negativeDefs, setNegativeDefs] = useState<ReviewTagDefinition[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      reviewService.getTagDefinitions('rider_to_driver', 'positive').catch(() => [] as ReviewTagDefinition[]),
      reviewService.getTagDefinitions('rider_to_driver', 'negative').catch(() => [] as ReviewTagDefinition[]),
    ]).then(([pos, neg]) => {
      if (cancelled) return;
      setPositiveDefs(pos);
      setNegativeDefs(neg);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Split + sort topTags into positive/negative buckets. */
  const { positive, negative } = useMemo(() => {
    if (!topTags || topTags.length === 0 || !positiveDefs || !negativeDefs) {
      return { positive: [] as ResolvedTag[], negative: [] as ResolvedTag[] };
    }
    const positiveKeys = new Set(positiveDefs.map((d) => d.key));
    const negativeKeys = new Set(negativeDefs.map((d) => d.key));
    const pos: ResolvedTag[] = [];
    const neg: ResolvedTag[] = [];
    for (const item of topTags) {
      if (positiveKeys.has(item.tag_key)) {
        pos.push({ key: item.tag_key, count: item.count, sentiment: 'positive' });
      } else if (negativeKeys.has(item.tag_key)) {
        neg.push({ key: item.tag_key, count: item.count, sentiment: 'negative' });
      }
      // Tags that don't match either bucket are dropped silently —
      // happens if a definition was deactivated after the review was
      // tagged. Showing them would be confusing without a sentiment
      // signal.
    }
    return { positive: pos, negative: neg };
  }, [topTags, positiveDefs, negativeDefs]);

  // Loading or no tags yet — render nothing rather than an empty
  // skeleton. The summary card above already gives the driver the
  // basics; the breakdown is supplemental.
  if (!topTags || topTags.length === 0) return null;
  if (positive.length === 0 && negative.length === 0) return null;

  return (
    <View style={{ marginBottom: 16 }}>
      <Text
        variant="caption"
        style={{
          color: midnightEmber.screen.text.secondary,
          textTransform: 'uppercase',
          letterSpacing: 1.2,
          fontWeight: '600',
          marginLeft: 4,
          marginBottom: 8,
        }}
      >
        {t('reviews.tags_breakdown_title', { defaultValue: 'Lo que destacan los pasajeros' })}
      </Text>

      {positive.length > 0 && (
        <View style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, marginLeft: 4 }}>
            <Ionicons
              name="thumbs-up"
              size={13}
              color={midnightEmber.state.success}
            />
            <Text
              variant="caption"
              style={{
                color: midnightEmber.state.success,
                marginLeft: 6,
                fontWeight: '600',
              }}
            >
              {t('reviews.tags_positive_label', { defaultValue: 'Lo bueno' })}
            </Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 4 }}>
              {positive.map((tag) => (
                <TagChip
                  key={tag.key}
                  label={t(`ride.tag_${tag.key}`, { ns: 'driver', defaultValue: tag.key.replace(/_/g, ' ') })}
                  count={tag.count}
                  color={midnightEmber.state.success}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {negative.length > 0 && (
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, marginLeft: 4 }}>
            <Ionicons
              name="alert-circle"
              size={13}
              color={midnightEmber.state.warning}
            />
            <Text
              variant="caption"
              style={{
                color: midnightEmber.state.warning,
                marginLeft: 6,
                fontWeight: '600',
              }}
            >
              {t('reviews.tags_negative_label', { defaultValue: 'Para mejorar' })}
            </Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 4 }}>
              {negative.map((tag) => (
                <TagChip
                  key={tag.key}
                  label={t(`ride.tag_${tag.key}`, { ns: 'driver', defaultValue: tag.key.replace(/_/g, ' ') })}
                  count={tag.count}
                  color={midnightEmber.state.warning}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      )}
    </View>
  );
}

interface TagChipProps {
  label: string;
  count: number;
  color: string;
}

function TagChip({ label, count, color }: TagChipProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: midnightEmber.radius.pill,
        backgroundColor: tinted(color),
        borderWidth: 1,
        borderColor: `${color}66`, // ~40%
      }}
    >
      <Text
        variant="caption"
        style={{ color, fontWeight: '600' }}
      >
        {label}
      </Text>
      <Text
        variant="caption"
        style={{ color, opacity: 0.7 }}
      >
        ×{count}
      </Text>
    </View>
  );
}

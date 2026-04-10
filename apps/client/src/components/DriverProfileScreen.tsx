// ============================================================
// TriciGo — DriverProfileScreen
// Full driver profile: photo, rating, stats, vehicle, reviews.
// ============================================================

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Image,
  ScrollView,
  Pressable,
  StyleSheet,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@tricigo/ui/Text';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from '@tricigo/i18n';
import { getInitials, logger } from '@tricigo/utils';
import { reviewService } from '@tricigo/api';
import { colors } from '@tricigo/theme';
import { useRideStore } from '@/stores/ride.store';
import type { ReviewSummary, ReviewWithReviewer, ReviewTagSentiment } from '@tricigo/types';

interface DriverProfileScreenProps {
  driverUserId: string;
}

export function DriverProfileScreen({ driverUserId }: DriverProfileScreenProps) {
  const { t } = useTranslation('rider');
  const router = useRouter();
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);

  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [reviews, setReviews] = useState<ReviewWithReviewer[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await reviewService.getDriverPublicProfile(driverUserId);
        if (cancelled) return;
        setSummary(result.summary);
        setReviews(result.recentReviews);
      } catch (err) {
        logger.error('Failed to load driver profile', { error: String(err) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [driverUserId]);

  const handleCall = useCallback(() => {
    const phone = rideWithDriver?.driver_masked_phone ?? rideWithDriver?.driver_phone;
    if (phone) Linking.openURL(`tel:${phone}`);
  }, [rideWithDriver]);

  const handleChat = useCallback(() => {
    const rideId = rideWithDriver?.id;
    if (rideId) router.push(`/chat/${rideId}`);
  }, [rideWithDriver, router]);

  // Derive data from rideWithDriver (already in store)
  const driverName = rideWithDriver?.driver_name ?? '—';
  const avatarUrl = rideWithDriver?.driver_avatar_url;
  const rating = summary?.average_rating ?? rideWithDriver?.driver_rating ?? 0;
  const totalRides = rideWithDriver?.driver_total_rides ?? 0;
  const vehicleMake = rideWithDriver?.vehicle_make;
  const vehicleModel = rideWithDriver?.vehicle_model;
  const vehicleColor = rideWithDriver?.vehicle_color;
  const vehiclePlate = rideWithDriver?.vehicle_plate;
  const vehicleYear = rideWithDriver?.vehicle_year;
  const vehiclePhotoUrl = rideWithDriver?.vehicle_photo_url;
  const initials = getInitials(driverName);

  return (
    <View style={styles.container}>
      {/* Header with back button */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backButton}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', { defaultValue: 'Back', ns: 'rider' })}
        >
          <Ionicons name="arrow-back" size={24} color="#1F2937" />
        </Pressable>
        <Text style={styles.headerTitle}>
          {t('ride.driver_profile_title', { defaultValue: 'Driver profile' })}
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Avatar */}
        <View style={styles.avatarSection}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.initialsText}>{initials}</Text>
            </View>
          )}
          <Text style={styles.driverName}>{driverName}</Text>
          <View style={styles.ratingRow}>
            <Ionicons name="star" size={18} color="#F59E0B" />
            <Text style={styles.ratingText}>{rating.toFixed(1)}</Text>
          </View>
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{totalRides}</Text>
            <Text style={styles.statLabel}>
              {t('ride.driver_profile_trips', { count: totalRides, defaultValue: '{{count}} trips' })}
            </Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Ionicons name="shield-checkmark-outline" size={20} color="#16A34A" />
            <Text style={styles.statLabel}>
              {t('ride.driver_profile_verified', { defaultValue: 'Verified' })}
            </Text>
          </View>
        </View>

        {/* Vehicle section */}
        {(vehicleMake || vehicleModel) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              {t('ride.driver_profile_vehicle', { defaultValue: 'Vehicle' })}
            </Text>
            <View style={styles.vehicleCard}>
              {vehiclePhotoUrl ? (
                <Image source={{ uri: vehiclePhotoUrl }} style={styles.vehiclePhoto} />
              ) : (
                <View style={[styles.vehiclePhoto, styles.vehiclePhotoPlaceholder]}>
                  <Ionicons name="car-outline" size={32} color="#9CA3AF" />
                </View>
              )}
              <View style={styles.vehicleInfo}>
                <Text style={styles.vehicleTitle}>
                  {[vehicleMake, vehicleModel, vehicleYear].filter(Boolean).join(' ')}
                </Text>
                {vehicleColor && (
                  <Text style={styles.vehicleSubtitle}>{vehicleColor}</Text>
                )}
                {vehiclePlate && (
                  <Text style={styles.vehiclePlate}>{vehiclePlate}</Text>
                )}
              </View>
            </View>
          </View>
        )}

        {/* Contact buttons */}
        <View style={styles.contactRow}>
          <Pressable
            style={styles.contactButton}
            onPress={handleCall}
            accessibilityRole="button"
            accessibilityLabel={t('common.call', { defaultValue: 'Call', ns: 'rider' })}
          >
            <Ionicons name="call-outline" size={20} color="#0EA5E9" />
            <Text style={styles.contactButtonText}>
              {t('common.call', { defaultValue: 'Call', ns: 'rider' })}
            </Text>
          </Pressable>
          <Pressable
            style={styles.contactButton}
            onPress={handleChat}
            accessibilityRole="button"
            accessibilityLabel={t('common.chat', { defaultValue: 'Chat', ns: 'rider' })}
          >
            <Ionicons name="chatbubble-outline" size={20} color="#0EA5E9" />
            <Text style={styles.contactButtonText}>
              {t('common.chat', { defaultValue: 'Chat', ns: 'rider' })}
            </Text>
          </Pressable>
        </View>

        {/* Reviews section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            {t('ride.driver_profile_reviews', { defaultValue: 'Recent reviews' })}
          </Text>

          {loading ? (
            <ActivityIndicator style={{ marginTop: 16 }} color="#0EA5E9" />
          ) : reviews.length === 0 ? (
            <Text style={styles.noReviews}>
              {t('ride.driver_profile_no_reviews', { defaultValue: 'No reviews yet' })}
            </Text>
          ) : (
            reviews.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

// ── Review card sub-component ──────────────────────────────

function ReviewCard({ review }: { review: ReviewWithReviewer }) {
  const stars = Array.from({ length: 5 }, (_, i) => (
    <Ionicons
      key={i}
      name={i < review.rating ? 'star' : 'star-outline'}
      size={14}
      color={i < review.rating ? '#F59E0B' : '#D1D5DB'}
    />
  ));

  const relativeDate = getRelativeDate(review.created_at);

  return (
    <View style={styles.reviewCard}>
      <View style={styles.reviewHeader}>
        {review.reviewer_avatar_url ? (
          <Image source={{ uri: review.reviewer_avatar_url }} style={styles.reviewerAvatar} />
        ) : (
          <View style={[styles.reviewerAvatar, styles.reviewerAvatarPlaceholder]}>
            <Text style={styles.reviewerInitial}>
              {review.reviewer_first_name?.[0]?.toUpperCase() ?? '?'}
            </Text>
          </View>
        )}
        <View style={styles.reviewerInfo}>
          <Text style={styles.reviewerName}>{review.reviewer_first_name}</Text>
          <View style={styles.starsRow}>{stars}</View>
        </View>
        <Text style={styles.reviewDate}>{relativeDate}</Text>
      </View>

      {review.comment && (
        <Text style={styles.reviewComment} numberOfLines={3}>
          {review.comment}
        </Text>
      )}

      {review.review_tags && review.review_tags.length > 0 && (
        <View style={styles.tagsRow}>
          {review.review_tags.map((tag) => (
            <View
              key={tag.key}
              style={[
                styles.tagChip,
                tag.sentiment === 'positive' ? styles.tagPositive : styles.tagNegative,
              ]}
            >
              <Text
                style={[
                  styles.tagText,
                  tag.sentiment === 'positive' ? styles.tagTextPositive : styles.tagTextNegative,
                ]}
              >
                {tag.label_es || tag.label_en}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ── Helpers ─────────────────────────────────────────────────

function getRelativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return 'Hoy';
  if (days === 1) return 'Ayer';
  if (days < 7) return `Hace ${days} días`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `Hace ${weeks} sem`;
  const months = Math.floor(days / 30);
  return `Hace ${months} mes${months > 1 ? 'es' : ''}`;
}

// ── Styles ──────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1F2937',
  },
  scrollContent: {
    paddingBottom: 40,
  },

  // Avatar
  avatarSection: {
    alignItems: 'center',
    paddingTop: 24,
    paddingBottom: 16,
  },
  avatar: {
    width: 120,
    height: 120,
    borderRadius: 60,
  },
  avatarPlaceholder: {
    backgroundColor: '#E0F2FE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  initialsText: {
    fontSize: 40,
    fontWeight: '700',
    color: '#0284C7',
  },
  driverName: {
    marginTop: 12,
    fontSize: 22,
    fontWeight: '700',
    color: '#1F2937',
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 4,
  },
  ratingText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
  },

  // Stats
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 32,
    marginTop: 8,
    marginBottom: 20,
    paddingVertical: 16,
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1F2937',
  },
  statLabel: {
    fontSize: 12,
    fontWeight: '400',
    color: '#6B7280',
  },
  statDivider: {
    width: 1,
    height: 32,
    backgroundColor: '#E5E7EB',
  },

  // Vehicle
  section: {
    paddingHorizontal: 20,
    marginTop: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1F2937',
    marginBottom: 12,
  },
  vehicleCard: {
    flexDirection: 'row',
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
  vehiclePhoto: {
    width: 80,
    height: 60,
    borderRadius: 8,
  },
  vehiclePhotoPlaceholder: {
    backgroundColor: '#E5E7EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  vehicleInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  vehicleTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1F2937',
  },
  vehicleSubtitle: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
  },
  vehiclePlate: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginTop: 4,
    letterSpacing: 1,
  },

  // Contact
  contactRow: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    marginTop: 20,
    marginBottom: 8,
  },
  contactButton: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  contactButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0EA5E9',
  },

  // Reviews
  noReviews: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    marginTop: 16,
  },
  reviewCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  reviewerAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  reviewerAvatarPlaceholder: {
    backgroundColor: '#E0F2FE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  reviewerInitial: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0284C7',
  },
  reviewerInfo: {
    flex: 1,
    marginLeft: 10,
  },
  reviewerName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1F2937',
  },
  starsRow: {
    flexDirection: 'row',
    gap: 1,
    marginTop: 2,
  },
  reviewDate: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  reviewComment: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 19,
    marginTop: 8,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  tagChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  tagPositive: {
    backgroundColor: '#DCFCE7',
  },
  tagNegative: {
    backgroundColor: '#FEE2E2',
  },
  tagText: {
    fontSize: 12,
    fontWeight: '500',
  },
  tagTextPositive: {
    color: '#16A34A',
  },
  tagTextNegative: {
    color: '#DC2626',
  },
});

// ============================================================
// TriciGo — DriverProfileScreen
// Full driver profile: photo, rating, stats, vehicle, reviews.
// ============================================================

import React, { useEffect, useMemo, useState, useCallback } from 'react';
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
import { getInitials, logger, triggerHaptic } from '@tricigo/utils';
import { reviewService } from '@tricigo/api';
import { colors } from '@tricigo/theme';
import { useRideStore } from '@/stores/ride.store';
import { useTokens, type Tokens } from '@/hooks/useTokens';
import type { ReviewSummary, ReviewWithReviewer, ReviewTagSentiment } from '@tricigo/types';

interface DriverProfileScreenProps {
  driverUserId: string;
}

export function DriverProfileScreen({ driverUserId }: DriverProfileScreenProps) {
  const { t } = useTranslation('rider');
  const router = useRouter();
  const rideWithDriver = useRideStore((s) => s.rideWithDriver);
  // Theme-aware styles — refactored from a static StyleSheet.create
  // because the previous version hardcoded #FFFFFF, #1F2937, etc.,
  // which made every text invisible on a dark background. Now the
  // sheet recomputes when the resolved theme switches.
  const tokens = useTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);

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
    if (phone) {
      // UX: match the consistent pattern from R2/R5/R6 — a light haptic
      // confirms the tap landed before the phone app hand-off.
      triggerHaptic('light');
      Linking.openURL(`tel:${phone}`);
    }
  }, [rideWithDriver]);

  const handleChat = useCallback(() => {
    const rideId = rideWithDriver?.id;
    if (rideId) {
      triggerHaptic('light');
      router.push(`/chat/${rideId}`);
    }
  }, [rideWithDriver, router]);

  const handleReport = useCallback(() => {
    const rideId = rideWithDriver?.id;
    if (!rideId) return;
    triggerHaptic('warning');
    router.push(`/ride/dispute/${rideId}`);
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
        {/* Avatar — UX: while summary + reviews fetch, the rest of the
             page used to render with placeholder zeros (rating 0.0, 0
             trips) that looked broken. Wrap the ratings area in a
             lightweight loading guard so numbers only surface once
             they're real. Avatar + name come from the ride store and
             are available immediately, so they stay visible. */}
        <View style={styles.avatarSection}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.initialsText}>{initials}</Text>
            </View>
          )}
          <Text style={styles.driverName}>{driverName}</Text>
          {loading && !summary ? (
            /* Subtle skeleton instead of "0.0 ★" which reads as failed. */
            <View style={[styles.ratingRow, { opacity: 0.5 }]}>
              <View style={{ width: 80, height: 18, borderRadius: 4, backgroundColor: '#E5E7EB' }} />
            </View>
          ) : (
            <View style={styles.ratingRow}>
              <Ionicons name="star" size={18} color="#F59E0B" />
              <Text style={styles.ratingText}>{rating.toFixed(1)}</Text>
              {/* UX: a rating number without a sample size hides the real
                   trust signal — 4.9 (1,200 reviews) is very different from
                   4.9 (3 reviews). Show the count when we have it. */}
              {summary && summary.total_reviews > 0 && (
                <Text style={styles.reviewCountText}>
                  {t('ride.driver_profile_review_count', {
                    count: summary.total_reviews,
                    defaultValue: `· ${summary.total_reviews} reseñas`,
                  })}
                </Text>
              )}
            </View>
          )}
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

        {/* UX: the dispute path (/ride/dispute/[rideId]) existed but was
             only reachable from deep menus. Riders rarely find it when
             they need it most — mid-trip they opened the driver profile
             instinctively. A muted ghost button right below the Call/Chat
             row gives them a clear path to report issues without
             dominating the visual hierarchy. Only shows when there's an
             active ride to dispute. */}
        {rideWithDriver?.id && (
          <Pressable
            style={styles.reportButton}
            onPress={handleReport}
            accessibilityRole="button"
            accessibilityLabel={t('ride.report_driver', { defaultValue: 'Reportar un problema con el conductor' })}
          >
            <Ionicons name="flag-outline" size={16} color="#9CA3AF" />
            <Text style={styles.reportButtonText}>
              {t('ride.report_driver', { defaultValue: 'Reportar un problema' })}
            </Text>
          </Pressable>
        )}

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
  const { t } = useTranslation('rider');
  // Sub-component computes its own theme-aware styles. Same pattern as
  // the parent — useTokens() + useMemo so the styles refresh when the
  // user toggles dark mode.
  const tokens = useTokens();
  const styles = useMemo(() => makeStyles(tokens), [tokens]);
  const stars = Array.from({ length: 5 }, (_, i) => (
    <Ionicons
      key={i}
      name={i < review.rating ? 'star' : 'star-outline'}
      size={14}
      color={i < review.rating ? '#F59E0B' : '#D1D5DB'}
    />
  ));

  const relativeDate = getRelativeDate(review.created_at, t);

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

// UX: dates were hardcoded in Spanish; for the English / Portuguese
// clients this rendered a jarring mix of languages. Thread t() through
// so the labels follow the user's selected locale. Defaults keep the
// previous Spanish copy so nothing regresses on existing setups.
function getRelativeDate(iso: string, t: (key: string, opts?: any) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return t('common.today', { defaultValue: 'Hoy' });
  if (days === 1) return t('common.yesterday', { defaultValue: 'Ayer' });
  if (days < 7) return t('common.days_ago', { count: days, defaultValue: `Hace ${days} días` });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return t('common.weeks_ago', { count: weeks, defaultValue: `Hace ${weeks} sem` });
  const months = Math.floor(days / 30);
  return t('common.months_ago', { count: months, defaultValue: `Hace ${months} mes${months > 1 ? 'es' : ''}` });
}

// ── Styles ──────────────────────────────────────────────────
// Theme-aware factory. Receives the resolved Cuban Modern palette
// from useTokens() and produces a StyleSheet with proper light/dark
// values. Recomputed via useMemo when scheme switches — see the hook
// call inside the component.

function makeStyles(tokens: Tokens) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: tokens.bg.paper,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 56,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: tokens.line,
    },
    backButton: {
      width: 44,
      height: 44,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: tokens.ink.primary,
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
      backgroundColor: tokens.accent.orangeGlow,
      justifyContent: 'center',
      alignItems: 'center',
    },
    initialsText: {
      fontSize: 40,
      fontWeight: '700',
      color: tokens.accent.orange,
    },
    driverName: {
      marginTop: 12,
      fontSize: 22,
      fontWeight: '700',
      color: tokens.ink.primary,
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
      color: tokens.ink.primary,
    },
    reviewCountText: {
      fontSize: 13,
      color: tokens.ink.secondary,
      marginLeft: 2,
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
      backgroundColor: tokens.bg.elev2,
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
      color: tokens.ink.primary,
    },
    statLabel: {
      fontSize: 12,
      fontWeight: '400',
      color: tokens.ink.secondary,
    },
    statDivider: {
      width: 1,
      height: 32,
      backgroundColor: tokens.line,
    },

    // Vehicle
    section: {
      paddingHorizontal: 20,
      marginTop: 8,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: tokens.ink.primary,
      marginBottom: 12,
    },
    vehicleCard: {
      flexDirection: 'row',
      backgroundColor: tokens.bg.elev1,
      borderRadius: 12,
      padding: 12,
      gap: 12,
      borderWidth: 1,
      borderColor: tokens.line,
    },
    vehiclePhoto: {
      width: 80,
      height: 60,
      borderRadius: 8,
    },
    vehiclePhotoPlaceholder: {
      backgroundColor: tokens.bg.elev2,
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
      color: tokens.ink.primary,
    },
    vehicleSubtitle: {
      fontSize: 13,
      color: tokens.ink.secondary,
      marginTop: 2,
    },
    vehiclePlate: {
      fontSize: 13,
      fontWeight: '600',
      color: tokens.ink.primary,
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
      borderColor: tokens.line,
      backgroundColor: tokens.bg.elev1,
      minHeight: 44, // HIG touch target
    },
    contactButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: tokens.accent.orange,
    },
    reportButton: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 10,
      marginHorizontal: 20,
      marginTop: 4,
      minHeight: 44,
    },
    reportButtonText: {
      fontSize: 12,
      fontWeight: '500',
      color: tokens.ink.subtle,
    },

    // Reviews
    noReviews: {
      fontSize: 14,
      color: tokens.ink.subtle,
      textAlign: 'center',
      marginTop: 16,
    },
    reviewCard: {
      backgroundColor: tokens.bg.elev1,
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: tokens.line,
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
      backgroundColor: tokens.accent.orangeGlow,
      justifyContent: 'center',
      alignItems: 'center',
    },
    reviewerInitial: {
      fontSize: 14,
      fontWeight: '700',
      color: tokens.accent.orange,
    },
    reviewerInfo: {
      flex: 1,
      marginLeft: 10,
    },
    reviewerName: {
      fontSize: 14,
      fontWeight: '600',
      color: tokens.ink.primary,
    },
    starsRow: {
      flexDirection: 'row',
      gap: 1,
      marginTop: 2,
    },
    reviewDate: {
      fontSize: 12,
      color: tokens.ink.subtle,
    },
    reviewComment: {
      fontSize: 13,
      color: tokens.ink.secondary,
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
    // Semantic positive/negative — kept as fixed hex pairs because
    // they need consistent meaning across themes (green = good,
    // red = bad). Light + dark variants below preserve the meaning
    // at appropriate contrast.
    tagPositive: {
      backgroundColor: 'rgba(22, 163, 74, 0.15)',
    },
    tagNegative: {
      backgroundColor: 'rgba(220, 38, 38, 0.15)',
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
}

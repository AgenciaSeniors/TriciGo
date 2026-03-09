import React, { useEffect, useState } from 'react';
import { View, Alert } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { driverService } from '@tricigo/api/services/driver';
import { reviewService } from '@tricigo/api/services/review';
import { formatCUP } from '@tricigo/utils';
import type { Ride } from '@tricigo/types';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';

export default function EarningsScreen() {
  const { t } = useTranslation('driver');
  const userId = useAuthStore((s) => s.user?.id);
  const driverProfileId = useDriverStore((s) => s.profile?.id);

  const [balance, setBalance] = useState(0);
  const [todayEarnings, setTodayEarnings] = useState(0);
  const [totalTrips, setTotalTrips] = useState(0);
  const [avgRating, setAvgRating] = useState<number | null>(null);
  const [totalReviews, setTotalReviews] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId || !driverProfileId) return;
    let cancelled = false;

    async function fetchData() {
      try {
        const [balanceData, trips] = await Promise.all([
          walletService.getBalance(userId!),
          driverService.getTripHistory(driverProfileId!, 0, 100),
        ]);

        if (cancelled) return;

        setBalance(balanceData.available);

        // Count completed trips and today's earnings
        const today = new Date().toDateString();
        let todaySum = 0;
        let completedCount = 0;
        for (const trip of trips) {
          if (trip.status === 'completed') {
            completedCount++;
            if (new Date(trip.completed_at ?? trip.created_at).toDateString() === today) {
              todaySum += trip.final_fare_cup ?? trip.estimated_fare_cup;
            }
          }
        }
        setTodayEarnings(todaySum);
        setTotalTrips(completedCount);

        // Fetch rating
        try {
          const summary = await reviewService.getReviewSummary(userId!);
          if (!cancelled && summary) {
            setAvgRating(summary.average_rating);
            setTotalReviews(summary.total_reviews);
          }
        } catch {
          // RPC might not exist yet — ignore
        }
      } catch (err) {
        console.error('Error fetching earnings:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    return () => { cancelled = true; };
  }, [userId, driverProfileId]);

  const handleRedeem = () => {
    Alert.alert(
      t('earnings.request_withdrawal'),
      t('earnings.withdrawal_info'),
    );
  };

  return (
    <Screen scroll bg="dark" statusBarStyle="light-content" padded>
      <View className="pt-4">
        <Text variant="h3" color="inverse" className="mb-4">
          {t('earnings.title')}
        </Text>

        <BalanceBadge
          balance={balance}
          size="lg"
          className="mb-6"
        />

        {/* Stats */}
        <View className="flex-row gap-3 mb-4">
          <Card variant="filled" padding="md" className="flex-1 bg-neutral-800">
            <Text variant="caption" color="inverse" className="opacity-50">
              {t('earnings.today')}
            </Text>
            <Text variant="h4" color="inverse" className="mt-1">
              {formatCUP(todayEarnings)}
            </Text>
          </Card>
          <Card variant="filled" padding="md" className="flex-1 bg-neutral-800">
            <Text variant="caption" color="inverse" className="opacity-50">
              {t('earnings.total_trips')}
            </Text>
            <Text variant="h4" color="inverse" className="mt-1">
              {totalTrips}
            </Text>
          </Card>
        </View>

        {/* Rating */}
        <Card variant="filled" padding="md" className="mb-6 bg-neutral-800">
          <Text variant="caption" color="inverse" className="opacity-50">
            {t('earnings.rating')}
          </Text>
          <View className="flex-row items-center mt-1">
            <Text variant="h4" color="inverse" className="mr-2">
              {avgRating != null ? `★ ${avgRating.toFixed(1)}` : '★ —'}
            </Text>
            <Text variant="bodySmall" color="inverse" className="opacity-50">
              {totalReviews > 0
                ? t('earnings.reviews_count', { count: totalReviews })
                : t('earnings.no_reviews')}
            </Text>
          </View>
        </Card>

        <Button
          title={t('earnings.redeem')}
          variant="outline"
          size="lg"
          fullWidth
          disabled={balance <= 0}
          onPress={handleRedeem}
        />
      </View>
    </Screen>
  );
}

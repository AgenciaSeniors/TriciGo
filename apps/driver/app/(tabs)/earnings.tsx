import React, { useEffect, useState, useCallback } from 'react';
import { View, ScrollView, RefreshControl, Alert } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Card } from '@tricigo/ui/Card';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { Input } from '@tricigo/ui/Input';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { driverService } from '@tricigo/api/services/driver';
import { reviewService } from '@tricigo/api/services/review';
import { formatCUP, formatTriciCoin, centavosToUnits } from '@tricigo/utils';
import type { WalletRedemption } from '@tricigo/types';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  requested: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  approved: { bg: 'bg-green-100', text: 'text-green-700' },
  processed: { bg: 'bg-blue-100', text: 'text-blue-700' },
  rejected: { bg: 'bg-red-100', text: 'text-red-700' },
};

const STATUS_LABEL: Record<string, { es: string }> = {
  requested: { es: 'Solicitado' },
  approved: { es: 'Aprobado' },
  processed: { es: 'Procesado' },
  rejected: { es: 'Rechazado' },
};

export default function EarningsScreen() {
  const { t } = useTranslation('driver');
  const userId = useAuthStore((s) => s.user?.id);
  const driverProfileId = useDriverStore((s) => s.profile?.id);

  const [balance, setBalance] = useState(0);
  const [todayEarnings, setTodayEarnings] = useState(0);
  const [todayCommission, setTodayCommission] = useState(0);
  const [totalTrips, setTotalTrips] = useState(0);
  const [avgRating, setAvgRating] = useState<number | null>(null);
  const [totalReviews, setTotalReviews] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Withdrawal state
  const [sheetVisible, setSheetVisible] = useState(false);
  const [redeemAmount, setRedeemAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [redemptions, setRedemptions] = useState<WalletRedemption[]>([]);

  const fetchData = useCallback(async () => {
    if (!userId || !driverProfileId) return;
    try {
      const [balanceData, trips, redHistory] = await Promise.all([
        walletService.getBalance(userId),
        driverService.getTripHistory(driverProfileId, 0, 100),
        walletService.getRedemptions(driverProfileId),
      ]);

      setBalance(balanceData.available);
      setRedemptions(redHistory);

      // Count completed trips and today's earnings
      const today = new Date().toDateString();
      let todaySum = 0;
      let todayComm = 0;
      let completedCount = 0;
      const COMMISSION_RATE = 0.15;
      for (const trip of trips) {
        if (trip.status === 'completed') {
          completedCount++;
          const tripFare = trip.final_fare_cup ?? trip.estimated_fare_cup;
          if (new Date(trip.completed_at ?? trip.created_at).toDateString() === today) {
            todaySum += tripFare;
            todayComm += Math.round(tripFare * COMMISSION_RATE);
          }
        }
      }
      setTodayEarnings(todaySum);
      setTodayCommission(todayComm);
      setTotalTrips(completedCount);

      // Fetch rating
      try {
        const summary = await reviewService.getReviewSummary(userId);
        if (summary) {
          setAvgRating(summary.average_rating);
          setTotalReviews(summary.total_reviews);
        }
      } catch {
        // RPC might not exist yet
      }
    } catch (err) {
      console.error('Error fetching earnings:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, driverProfileId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  const handleRedeem = () => {
    setRedeemAmount('');
    setSheetVisible(true);
  };

  const handleConfirmRedeem = async () => {
    if (!driverProfileId) return;
    const parsed = parseFloat(redeemAmount);
    if (isNaN(parsed) || parsed <= 0) {
      Alert.alert('Error', t('earnings.amount_error_min'));
      return;
    }
    const amountCentavos = Math.round(parsed * 100);
    if (amountCentavos > balance) {
      Alert.alert('Error', t('earnings.amount_error_max'));
      return;
    }
    setSubmitting(true);
    try {
      await walletService.requestRedemption(driverProfileId, amountCentavos);
      setSheetVisible(false);
      Alert.alert('', t('earnings.withdrawal_success'));
      fetchData();
    } catch (err) {
      console.error('Error requesting redemption:', err);
      Alert.alert('Error', t('earnings.withdrawal_info'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen bg="dark" statusBarStyle="light-content">
      <ScrollView
        className="flex-1 px-5"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />
        }
      >
        <View className="pt-4 pb-8">
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
                {t('earnings.net_today', { defaultValue: 'Ganancia neta hoy' })}
              </Text>
              <Text variant="h4" color="inverse" className="mt-1">
                {formatCUP(todayEarnings - todayCommission)}
              </Text>
              {todayCommission > 0 && (
                <Text variant="caption" className="text-red-400 mt-0.5">
                  {t('earnings.commission_label', { defaultValue: 'Comisión' })}: {formatCUP(todayCommission)}
                </Text>
              )}
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

          {/* Withdrawal history */}
          {redemptions.length > 0 && (
            <View className="mt-8">
              <Text variant="h4" color="inverse" className="mb-3">
                {t('earnings.withdrawal_history')}
              </Text>
              {redemptions.map((r) => {
                const colors = STATUS_COLORS[r.status] ?? { bg: 'bg-yellow-100', text: 'text-yellow-700' };
                const label = STATUS_LABEL[r.status]?.es ?? r.status;
                return (
                  <Card key={r.id} variant="filled" padding="md" className="mb-2 bg-neutral-800">
                    <View className="flex-row items-center justify-between">
                      <View>
                        <Text variant="body" color="inverse" className="font-semibold">
                          {formatTriciCoin(r.amount)}
                        </Text>
                        <Text variant="caption" color="inverse" className="opacity-50 mt-0.5">
                          {new Date(r.requested_at).toLocaleDateString('es-CU', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </Text>
                      </View>
                      <View className={`px-2 py-0.5 rounded-full ${colors.bg}`}>
                        <Text className={`text-xs font-medium ${colors.text}`}>
                          {label}
                        </Text>
                      </View>
                    </View>
                    {r.rejection_reason && (
                      <Text variant="caption" className="text-red-400 mt-1">
                        {r.rejection_reason}
                      </Text>
                    )}
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Withdrawal BottomSheet */}
      <BottomSheet visible={sheetVisible} onClose={() => setSheetVisible(false)}>
        <Text className="text-lg font-bold mb-4">{t('earnings.request_withdrawal')}</Text>
        <Input
          label={t('earnings.redeem_amount')}
          placeholder="0.00"
          keyboardType="decimal-pad"
          value={redeemAmount}
          onChangeText={setRedeemAmount}
          hint={`${t('earnings.balance')}: ${formatTriciCoin(balance)}`}
        />
        <Button
          title={submitting ? '...' : t('earnings.redeem_confirm_btn')}
          variant="primary"
          size="lg"
          fullWidth
          disabled={submitting || !redeemAmount.trim()}
          onPress={handleConfirmRedeem}
        />
      </BottomSheet>
    </Screen>
  );
}

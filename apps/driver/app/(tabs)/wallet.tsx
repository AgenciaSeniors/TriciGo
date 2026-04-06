import React, { useEffect, useState, useCallback } from 'react';
import { View, RefreshControl, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { SkeletonBalance, SkeletonCard } from '@tricigo/ui/Skeleton';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { exchangeRateService } from '@tricigo/api/services/exchange-rate';
import { formatTRC, formatUSD, trcToUsd, DEFAULT_EXCHANGE_RATE } from '@tricigo/utils';
import { QuotaCard } from '@tricigo/ui/QuotaCard';
import type { DriverQuotaStatus } from '@tricigo/types';
import { colors, driverDarkColors } from '@tricigo/theme';
import { useDriverStore } from '@/stores/driver.store';
import { useAuthStore } from '@/stores/auth.store';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedCard, StaggeredList } from '@tricigo/ui/AnimatedCard';
import AsyncStorage from '@react-native-async-storage/async-storage';

type CommissionEntry = {
  id: string;
  ride_id: string;
  amount: number;
  commission_rate: number;
  created_at: string;
  type: 'ride' | 'tip' | 'bonus' | 'referral' | 'surge';
};

type EarningGoal = {
  label: string;
  target: number;
  current: number;
};

const GOAL_STORAGE_KEY = '@tricigo/earning_goals';

const COMMISSION_TYPE_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  ride: 'car',
  tip: 'heart',
  bonus: 'star',
  referral: 'people',
  surge: 'trending-up',
};

const COMMISSION_TYPE_COLORS: Record<string, string> = {
  ride: colors.brand.orange,
  tip: colors.success.DEFAULT,
  bonus: colors.warning.DEFAULT,
  referral: colors.info.DEFAULT,
  surge: '#a855f7',
};

export default function WalletScreen() {
  const { t } = useTranslation('driver');
  const userId = useAuthStore((s) => s.user?.id);
  const driverProfile = useDriverStore((s) => s.profile);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [balance, setBalance] = useState(0);
  const [holdBalance, setHoldBalance] = useState(0);
  const [commissions, setCommissions] = useState<CommissionEntry[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [quotaStatus, setQuotaStatus] = useState<DriverQuotaStatus | null>(null);
  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE);
  const [goals, setGoals] = useState<EarningGoal[]>([
    { label: t('wallet.goal_daily', { defaultValue: 'Meta diaria' }), target: 5000, current: 0 },
    { label: t('wallet.goal_weekly', { defaultValue: 'Meta semanal' }), target: 25000, current: 0 },
    { label: t('wallet.goal_monthly', { defaultValue: 'Meta mensual' }), target: 80000, current: 0 },
  ]);

  const fetchData = useCallback(async () => {
    if (!driverProfile?.id || !userId) return;
    try {
      const [balanceData, txData, quotaData, rateData] = await Promise.all([
        walletService.getBalance(userId),
        walletService.getTransactions(userId, 0, 50),
        walletService.getQuotaStatus(userId).catch(() => null),
        exchangeRateService.getUsdCupRate().catch(() => DEFAULT_EXCHANGE_RATE),
      ]);
      setBalance(balanceData?.available ?? 0);
      setHoldBalance(balanceData?.held ?? 0);
      if (quotaData) setQuotaStatus(quotaData);
      setExchangeRate(rateData);

      // Map transactions to commission entries
      const mapped: CommissionEntry[] = (txData ?? []).map((tx) => ({
        id: tx.id,
        ride_id: (tx as unknown as Record<string, unknown>).ride_id as string ?? '',
        amount: tx.amount ?? 0,
        commission_rate: ((tx as unknown as Record<string, unknown>).commission_rate as number) ?? 0.15,
        created_at: tx.created_at,
        type: (tx.type as CommissionEntry['type']) ?? 'ride',
      }));
      setCommissions(mapped);

      // Calculate goal progress from today/week/month earnings
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const dailyEarnings = mapped.filter((c) => c.created_at >= todayStart).reduce((sum, c) => sum + c.amount, 0);
      const weeklyEarnings = mapped.filter((c) => c.created_at >= weekStart).reduce((sum, c) => sum + c.amount, 0);
      const monthlyEarnings = mapped.filter((c) => c.created_at >= monthStart).reduce((sum, c) => sum + c.amount, 0);

      // Load saved goal targets
      const savedGoals = await AsyncStorage.getItem(GOAL_STORAGE_KEY).catch(() => null);
      const targets = savedGoals ? JSON.parse(savedGoals) : null;

      setGoals([
        { label: t('wallet.goal_daily', { defaultValue: 'Meta diaria' }), target: targets?.daily ?? 5000, current: dailyEarnings },
        { label: t('wallet.goal_weekly', { defaultValue: 'Meta semanal' }), target: targets?.weekly ?? 25000, current: weeklyEarnings },
        { label: t('wallet.goal_monthly', { defaultValue: 'Meta mensual' }), target: targets?.monthly ?? 80000, current: monthlyEarnings },
      ]);
    } catch {
      // silent fail
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [driverProfile?.id, userId, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  const filteredCommissions = filter
    ? commissions.filter((c) => c.type === filter)
    : commissions;

  const filterTypes = ['ride', 'tip', 'bonus', 'referral', 'surge'] as const;

  if (loading) {
    return (
      <Screen bg="dark" statusBarStyle="light-content" padded scroll>
        <View className="pt-4">
          <Text variant="h3" color="inverse" className="mb-4">
            {t('wallet.title', { defaultValue: 'Billetera' })}
          </Text>
          <SkeletonBalance />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      </Screen>
    );
  }

  return (
    <Screen
      bg="dark"
      statusBarStyle="light-content"
      padded
      scroll
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand.orange} />}
    >
      <View className="pt-4 pb-8">
        <Text variant="h3" color="inverse" className="mb-4">
          {t('wallet.title', { defaultValue: 'Billetera' })}
        </Text>

        {/* Quota Card */}
        {quotaStatus && (
          <AnimatedCard delay={0} className="mb-4">
            <QuotaCard
              balance={quotaStatus.balance}
              totalRecharged={quotaStatus.total_recharged}
              exchangeRate={exchangeRate}
              deductionRate={quotaStatus.deduction_rate}
              warningActive={quotaStatus.warning_active}
              graceTripsRemaining={quotaStatus.grace_trips_remaining}
              blocked={quotaStatus.blocked}
              onRecharge={() => router.push('/wallet/recharge')}
              labels={{
                title: t('wallet.quota_title', { defaultValue: 'Cuota de trabajo' }),
                balance: t('wallet.quota_balance', { defaultValue: 'Balance de cuota' }),
                recharge: t('wallet.recharge_quota', { defaultValue: 'Recargar cuota' }),
                lowWarning: t('wallet.quota_low_warning', { defaultValue: 'Tu cuota esta baja. Recarga pronto para seguir trabajando.' }),
                graceMessage: t('wallet.quota_grace', { defaultValue: 'Cuota agotada. Te quedan {count} viajes de gracia.' }),
                blockedMessage: t('wallet.quota_blocked', { defaultValue: 'Cuota agotada. Recarga para seguir aceptando viajes.' }),
                deductionInfo: t('wallet.quota_deduction_info', { defaultValue: 'Se descuenta {pct} del valor de cada viaje.' }),
              }}
            />
          </AnimatedCard>
        )}

        {/* Earnings Balance Card */}
        <AnimatedCard delay={100} className="rounded-2xl p-5 mb-6"
          style={{ backgroundColor: driverDarkColors.card, borderWidth: 1, borderColor: driverDarkColors.border.default }}
        >
          <Text variant="caption" style={{ color: colors.neutral[400] }} className="mb-1">
            {t('wallet.available_balance', { defaultValue: 'Saldo disponible' })}
          </Text>
          <Text variant="stat" className="text-white">{formatTRC(balance)}</Text>
          <Text variant="caption" style={{ color: colors.neutral[500] }} className="mt-0.5">
            {'\u2248'} {formatUSD(trcToUsd(balance, exchangeRate))}
          </Text>
          {holdBalance > 0 && (
            <Text variant="caption" style={{ color: colors.neutral[400] }} className="mt-1">
              {t('wallet.hold_balance', { defaultValue: 'En retencion' })}: {formatTRC(holdBalance)}
            </Text>
          )}
        </AnimatedCard>

        {/* Earning Goals */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('wallet.earning_goals', { defaultValue: 'Metas de ganancia' })}
        </Text>
        <View className="flex-row gap-2 mb-6">
          {goals.map((goal, goalIdx) => {
            const progress = Math.min(goal.current / goal.target, 1);
            const isComplete = progress >= 1;
            return (
              <AnimatedCard
                key={goal.label}
                delay={100 + goalIdx * 80}
                className="flex-1 rounded-2xl p-3"
                style={{ backgroundColor: driverDarkColors.card, borderWidth: 1, borderColor: isComplete ? colors.success.DEFAULT : driverDarkColors.border.default }}
              >
                <Text variant="caption" style={{ color: colors.neutral[400] }} className="mb-1">
                  {goal.label}
                </Text>
                <Text variant="metric" className="text-white mb-2">
                  {formatTRC(goal.current)}
                </Text>
                {/* Progress bar */}
                <View className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: driverDarkColors.border.default }}>
                  <View
                    className="h-full rounded-full"
                    style={{
                      width: `${progress * 100}%`,
                      backgroundColor: isComplete ? colors.success.DEFAULT : colors.brand.orange,
                    }}
                  />
                </View>
                <Text variant="caption" style={{ color: colors.neutral[500] }} className="mt-1">
                  {t('wallet.goal_of', { defaultValue: 'de' })} {formatTRC(goal.target)}
                </Text>
              </AnimatedCard>
            );
          })}
        </View>

        {/* Commission History */}
        <Text variant="label" color="secondary" className="mb-2 ml-1">
          {t('wallet.commission_history', { defaultValue: 'Historial de comisiones' })}
        </Text>

        {/* Filter chips */}
        <View className="flex-row mb-3 gap-2 flex-wrap">
          <Pressable
            onPress={() => setFilter(null)}
            hitSlop={4}
            className="px-4 py-2.5 rounded-full"
            style={{
              backgroundColor: filter === null ? colors.brand.orange : driverDarkColors.hover,
              borderWidth: 1,
              borderColor: filter === null ? colors.brand.orange : driverDarkColors.border.default,
            }}
          >
            <Text variant="caption" color={filter === null ? 'inverse' : 'secondary'}>
              {t('wallet.filter_all', { defaultValue: 'Todos' })}
            </Text>
          </Pressable>
          {filterTypes.map((type) => (
            <Pressable
              key={type}
              onPress={() => setFilter(filter === type ? null : type)}
              hitSlop={4}
              className="px-4 py-2.5 rounded-full flex-row items-center gap-1"
              style={{
                backgroundColor: filter === type ? COMMISSION_TYPE_COLORS[type] : driverDarkColors.hover,
                borderWidth: 1,
                borderColor: filter === type ? COMMISSION_TYPE_COLORS[type] : driverDarkColors.border.default,
              }}
            >
              <Ionicons
                name={COMMISSION_TYPE_ICONS[type]}
                size={12}
                color={filter === type ? '#FFFFFF' : COMMISSION_TYPE_COLORS[type]}
              />
              <Text variant="caption" color={filter === type ? 'inverse' : 'secondary'}>
                {t(`wallet.type_${type}`, { defaultValue: type })}
              </Text>
            </Pressable>
          ))}
        </View>

        {filteredCommissions.length === 0 ? (
          <EmptyState
            forceDark
            icon="receipt-outline"
            title={t('wallet.no_commissions', { defaultValue: 'Sin comisiones aún' })}
            description={t('wallet.no_commissions_desc', { defaultValue: 'Tus comisiones aparecerán aquí' })}
          />
        ) : (
          <StaggeredList staggerDelay={60}>
            {filteredCommissions.map((entry) => (
              <View
                key={entry.id}
                className="rounded-xl p-4 flex-row items-center mb-2"
                style={{ backgroundColor: driverDarkColors.card, borderWidth: 1, borderColor: driverDarkColors.border.default }}
              >
                <View
                  className="w-10 h-10 rounded-xl items-center justify-center mr-3"
                  style={{ backgroundColor: `${COMMISSION_TYPE_COLORS[entry.type]}20` }}
                >
                  <Ionicons
                    name={COMMISSION_TYPE_ICONS[entry.type] ?? 'cash'}
                    size={20}
                    color={COMMISSION_TYPE_COLORS[entry.type] ?? colors.brand.orange}
                  />
                </View>
                <View className="flex-1">
                  <Text variant="body" color="inverse">
                    {t(`wallet.type_${entry.type}`, { defaultValue: entry.type })}
                  </Text>
                  <Text variant="caption" style={{ color: colors.neutral[500] }}>
                    {new Date(entry.created_at).toLocaleDateString()}
                  </Text>
                </View>
                <Text variant="body" style={{ color: colors.success.DEFAULT, fontWeight: '700' }}>
                  +{formatTRC(entry.amount)}
                </Text>
              </View>
            ))}
          </StaggeredList>
        )}
      </View>
    </Screen>
  );
}

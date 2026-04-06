import React, { useState, useEffect, useCallback } from 'react';
import { View, FlatList, Pressable, RefreshControl, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { Card } from '@tricigo/ui/Card';
import { StatCard } from '@tricigo/ui/StatCard';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api';
import { formatCUP } from '@tricigo/utils';
import { colors } from '@tricigo/theme';
import { useAuthStore } from '@/stores/auth.store';
import type { LedgerTransaction, WalletSummary } from '@tricigo/types';

const PAGE_SIZE = 20;

export default function WalletScreen() {
  const { t } = useTranslation('driver');
  const insets = useSafeAreaInsets();
  const userId = useAuthStore((s) => s.user?.id);
  const [summary, setSummary] = useState<WalletSummary | null>(null);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const fetchData = useCallback(async (reset = false) => {
    if (!userId) return;
    try {
      const p = reset ? 1 : page;
      const [summaryData, txData] = await Promise.all([
        walletService.getSummary(userId),
        walletService.getTransactions(userId, p, PAGE_SIZE),
      ]);
      setSummary(summaryData);
      if (reset) {
        setTransactions(txData);
        setPage(2);
      } else {
        setTransactions((prev) => [...prev, ...txData]);
        setPage((prev) => prev + 1);
      }
      setHasMore(txData.length === PAGE_SIZE);
    } catch {
      // Silent — wallet is best-effort
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, page]);

  useEffect(() => {
    fetchData(true);
  }, [userId]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData(true);
  };

  const handleLoadMore = () => {
    if (hasMore && !loading) fetchData(false);
  };

  const getTransactionIcon = (type: string): string => {
    switch (type) {
      case 'ride_payment': return 'car';
      case 'commission': return 'trending-down';
      case 'tip': return 'heart';
      case 'transfer_in': return 'arrow-down';
      case 'transfer_out': return 'arrow-up';
      case 'recharge': return 'add-circle';
      case 'promo_credit': return 'gift';
      case 'redemption': return 'wallet';
      default: return 'swap-horizontal';
    }
  };

  const getTransactionColor = (type: string): string => {
    if (['ride_payment', 'tip', 'transfer_in', 'recharge', 'promo_credit'].includes(type)) {
      return colors.success.DEFAULT;
    }
    return colors.error.DEFAULT;
  };

  const isCreditType = (type: string): boolean => {
    return ['ride_payment', 'tip', 'transfer_in', 'recharge', 'promo_credit'].includes(type);
  };

  const renderTransaction = ({ item }: { item: LedgerTransaction & { ledger_entries?: { amount: number }[] } }) => {
    const amount = (item as any).ledger_entries?.[0]?.amount ?? 0;
    const txColor = getTransactionColor(item.type);
    return (
      <Pressable
        className="flex-row items-center py-3.5 px-4"
        style={({ pressed }) => [
          { borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' },
          pressed && { backgroundColor: 'rgba(255,255,255,0.03)' },
        ]}
        accessibilityRole="summary"
        accessibilityLabel={`${item.type}: ${formatCUP(Math.abs(amount))}`}
      >
        <View
          className="w-10 h-10 rounded-xl items-center justify-center mr-3"
          style={{ backgroundColor: `${txColor}12` }}
        >
          <Ionicons
            name={getTransactionIcon(item.type) as any}
            size={18}
            color={txColor}
          />
        </View>
        <View className="flex-1">
          <Text variant="body" color="inverse" className="font-medium">
            {t(`wallet.tx_${item.type}`, { defaultValue: item.type.replace(/_/g, ' ') })}
          </Text>
          <Text variant="caption" color="secondary" className="mt-0.5">
            {new Date(item.created_at).toLocaleDateString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
        <Text
          variant="body"
          className="font-bold tabular-nums"
          style={{ color: txColor }}
        >
          {isCreditType(item.type) ? '+' : '-'}{formatCUP(Math.abs(amount))}
        </Text>
      </Pressable>
    );
  };

  if (loading) {
    return (
      <Screen bg="dark" statusBarStyle="light-content">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={colors.brand.orange} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="dark" statusBarStyle="light-content">
      <FlatList
        data={transactions}
        keyExtractor={(item) => item.id}
        renderItem={renderTransaction}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.3}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.brand.orange}
          />
        }
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }}
        ListHeaderComponent={
          <View className="px-4 mb-4">
            {/* Header */}
            <View className="flex-row items-center mb-6">
              <Pressable
                onPress={() => router.back()}
                className="w-11 h-11 rounded-xl items-center justify-center mr-3"
                style={{ backgroundColor: '#252540' }}
                accessibilityRole="button"
                accessibilityLabel={t('common.back', { defaultValue: 'Volver' })}
              >
                <Ionicons name="arrow-back" size={20} color="#fff" />
              </Pressable>
              <Text variant="h2" color="inverse">
                {t('wallet.title', { defaultValue: 'Wallet' })}
              </Text>
            </View>

            {/* Balance card */}
            <Card forceDark variant="surface" padding="lg" className="mb-4">
              <Text variant="caption" color="secondary" className="mb-1">
                {t('wallet.available_balance', { defaultValue: 'Balance disponible' })}
              </Text>
              <Text variant="stat" color="inverse">
                {formatCUP(summary?.available_balance ?? 0)}
              </Text>
              {(summary?.held_balance ?? 0) > 0 && (
                <Text variant="caption" color="secondary" className="mt-1">
                  {t('wallet.held', { defaultValue: 'Retenido' })}: {formatCUP(summary?.held_balance ?? 0)}
                </Text>
              )}
            </Card>

            {/* Action buttons */}
            <View className="flex-row gap-3 mb-4">
              <Pressable
                onPress={() => router.push('/wallet/transfer')}
                className="flex-1 items-center justify-center py-4 rounded-2xl"
                style={({ pressed }) => [
                  { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', minHeight: 56 },
                  pressed && { backgroundColor: '#252540', transform: [{ scale: 0.97 }] },
                ]}
                accessibilityRole="button"
                accessibilityLabel={t('wallet.transfer', { defaultValue: 'Transferir' })}
              >
                <View className="w-10 h-10 rounded-full items-center justify-center mb-1" style={{ backgroundColor: 'rgba(255,77,0,0.1)' }}>
                  <Ionicons name="swap-horizontal" size={20} color={colors.brand.orange} />
                </View>
                <Text variant="bodySmall" color="inverse" className="font-semibold">
                  {t('wallet.transfer', { defaultValue: 'Transferir' })}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/wallet/recharge')}
                className="flex-1 items-center justify-center py-4 rounded-2xl"
                style={({ pressed }) => [
                  { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', minHeight: 56 },
                  pressed && { backgroundColor: '#252540', transform: [{ scale: 0.97 }] },
                ]}
                accessibilityRole="button"
                accessibilityLabel={t('wallet.recharge', { defaultValue: 'Recargar' })}
              >
                <View className="w-10 h-10 rounded-full items-center justify-center mb-1" style={{ backgroundColor: 'rgba(255,77,0,0.1)' }}>
                  <Ionicons name="add-circle-outline" size={20} color={colors.brand.orange} />
                </View>
                <Text variant="bodySmall" color="inverse" className="font-semibold">
                  {t('wallet.recharge', { defaultValue: 'Recargar' })}
                </Text>
              </Pressable>
            </View>

            {/* Stats row */}
            <View className="flex-row gap-3 mb-4">
              <View className="flex-1">
                <StatCard
                  forceDark
                  icon="trending-up"
                  value={formatCUP(summary?.total_earned ?? 0)}
                  label={t('wallet.total_earned', { defaultValue: 'Total ganado' })}
                  iconColor={colors.success.DEFAULT}
                />
              </View>
              <View className="flex-1">
                <StatCard
                  forceDark
                  icon="trending-down"
                  value={formatCUP(summary?.total_spent ?? 0)}
                  label={t('wallet.total_spent', { defaultValue: 'Total gastado' })}
                  iconColor={colors.error.DEFAULT}
                />
              </View>
            </View>

            {/* Transactions header */}
            <Text variant="h4" color="inverse" className="mb-2">
              {t('wallet.transactions', { defaultValue: 'Transacciones' })}
            </Text>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            forceDark
            icon="wallet-outline"
            title={t('wallet.no_transactions_title', { defaultValue: 'Sin transacciones' })}
            description={t('wallet.no_transactions', { defaultValue: 'Aun no tienes transacciones. Completa viajes para empezar a ganar.' })}
          />
        }
      />
    </Screen>
  );
}

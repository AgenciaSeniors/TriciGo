import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, ActivityIndicator, Alert, RefreshControl } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Button } from '@tricigo/ui/Button';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { formatTriciCoin } from '@tricigo/utils';
import type { LedgerTransaction } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  return date.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' });
}

export default function WalletScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);

  const [balance, setBalance] = useState({ available: 0, held: 0 });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      const [balanceData, account] = await Promise.all([
        walletService.getBalance(userId),
        walletService.getAccount(userId),
      ]);
      setBalance(balanceData);
      setAccountId(account?.id ?? null);

      if (account?.id) {
        const txns = await walletService.getTransactions(account.id, 0, 20);
        setTransactions(txns);
      }
    } catch (err) {
      console.error('Error fetching wallet:', err);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      await fetchData();
      if (!cancelled) setLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [userId, fetchData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleRecharge = () => {
    Alert.alert(t('wallet.recharge'), t('wallet.coming_soon'));
  };

  const handleTransfer = () => {
    Alert.alert(t('wallet.transfer'), t('wallet.coming_soon'));
  };

  const renderTransaction = ({ item }: { item: LedgerTransaction }) => (
    <View className="flex-row items-center py-3 border-b border-neutral-100">
      <View className="flex-1">
        <Text variant="bodySmall" numberOfLines={1}>{item.description}</Text>
        <Text variant="caption" color="tertiary">{formatDate(item.created_at)}</Text>
      </View>
    </View>
  );

  if (loading) {
    return (
      <Screen bg="white" padded>
        <View className="flex-1 items-center justify-center py-20">
          <ActivityIndicator size="large" color="#FF4D00" />
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <Text variant="h3" className="mb-4">
          {t('wallet.title')}
        </Text>

        <BalanceBadge
          balance={balance.available}
          held={balance.held}
          size="lg"
          showHeld
          className="mb-6"
        />

        <View className="flex-row gap-3 mb-8">
          <Button
            title={t('wallet.recharge')}
            variant="primary"
            size="md"
            className="flex-1"
            onPress={handleRecharge}
          />
          <Button
            title={t('wallet.transfer')}
            variant="outline"
            size="md"
            className="flex-1"
            onPress={handleTransfer}
          />
        </View>

        <Text variant="h4" className="mb-3">
          {t('wallet.history')}
        </Text>

        <FlatList
          data={transactions}
          keyExtractor={(item) => item.id}
          renderItem={renderTransaction}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FF4D00" />
          }
          ListEmptyComponent={
            <View className="items-center py-10">
              <Text variant="body" color="tertiary">
                {t('wallet.no_transactions')}
              </Text>
            </View>
          }
        />
      </View>
    </Screen>
  );
}

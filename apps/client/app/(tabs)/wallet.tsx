import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, ActivityIndicator, Alert, RefreshControl, TextInput } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { formatTriciCoin, normalizeCubanPhone, isValidCubanPhone } from '@tricigo/utils';
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

  // Recharge state
  const [rechargeSheetVisible, setRechargeSheetVisible] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeSubmitting, setRechargeSubmitting] = useState(false);

  // Transfer state
  const [transferSheetVisible, setTransferSheetVisible] = useState(false);
  const [transferPhone, setTransferPhone] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferRecipient, setTransferRecipient] = useState<{ id: string; full_name: string } | null>(null);
  const [transferSearching, setTransferSearching] = useState(false);
  const [transferSubmitting, setTransferSubmitting] = useState(false);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      await walletService.ensureAccount(userId);
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

  // Recharge handlers
  const handleRecharge = () => {
    setRechargeAmount('');
    setRechargeSheetVisible(true);
  };

  const submitRecharge = async () => {
    const amountNum = parseInt(rechargeAmount, 10);
    if (!amountNum || amountNum <= 0 || !userId) return;
    setRechargeSubmitting(true);
    try {
      await walletService.requestRecharge(userId, amountNum * 100);
      setRechargeSheetVisible(false);
      Alert.alert(t('wallet.recharge'), t('wallet.recharge_success'));
    } catch (err) {
      console.error('Error requesting recharge:', err);
      Alert.alert(t('error'), t('errors.generic'));
    } finally {
      setRechargeSubmitting(false);
    }
  };

  // Transfer handlers
  const handleTransfer = () => {
    setTransferPhone('');
    setTransferAmount('');
    setTransferNote('');
    setTransferRecipient(null);
    setTransferSheetVisible(true);
  };

  const searchRecipient = async () => {
    if (!isValidCubanPhone(transferPhone)) return;
    setTransferSearching(true);
    setTransferRecipient(null);
    try {
      const normalized = normalizeCubanPhone(transferPhone);
      const user = await walletService.findUserByPhone(normalized);
      if (user && user.id !== userId) {
        setTransferRecipient({ id: user.id, full_name: user.full_name });
      } else if (user && user.id === userId) {
        Alert.alert(t('error'), t('wallet.transfer_user_not_found'));
      } else {
        Alert.alert(t('error'), t('wallet.transfer_user_not_found'));
      }
    } catch {
      Alert.alert(t('error'), t('errors.generic'));
    } finally {
      setTransferSearching(false);
    }
  };

  const submitTransfer = async () => {
    if (!transferRecipient || !userId) return;
    const amountNum = parseInt(transferAmount, 10);
    if (!amountNum || amountNum <= 0) return;

    const amountCentavos = amountNum * 100;
    if (amountCentavos > balance.available) {
      Alert.alert(t('error'), t('wallet.transfer_insufficient'));
      return;
    }

    setTransferSubmitting(true);
    try {
      await walletService.transferP2P(
        userId,
        transferRecipient.id,
        amountCentavos,
        transferNote || undefined,
      );
      setTransferSheetVisible(false);
      Alert.alert(t('wallet.transfer'), t('wallet.transfer_success'));
      await fetchData();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('errors.generic');
      Alert.alert(t('error'), message);
    } finally {
      setTransferSubmitting(false);
    }
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

      {/* Recharge BottomSheet */}
      <BottomSheet
        visible={rechargeSheetVisible}
        onClose={() => setRechargeSheetVisible(false)}
      >
        <View className="px-4 pb-6">
          <Text variant="h4" className="mb-4">{t('wallet.request_recharge')}</Text>
          <Text variant="bodySmall" color="secondary" className="mb-3">
            {t('wallet.recharge_amount')} (CUP)
          </Text>
          <TextInput
            className="border border-neutral-200 rounded-lg p-3 mb-4 text-neutral-900 text-lg"
            placeholder="500"
            value={rechargeAmount}
            onChangeText={setRechargeAmount}
            keyboardType="numeric"
          />
          <Button
            title={t('wallet.request_recharge')}
            size="lg"
            fullWidth
            onPress={submitRecharge}
            loading={rechargeSubmitting}
            disabled={!rechargeAmount || parseInt(rechargeAmount, 10) <= 0}
          />
        </View>
      </BottomSheet>

      {/* Transfer BottomSheet */}
      <BottomSheet
        visible={transferSheetVisible}
        onClose={() => setTransferSheetVisible(false)}
      >
        <View className="px-4 pb-6">
          <Text variant="h4" className="mb-4">{t('wallet.transfer_title')}</Text>

          {/* Phone input + search */}
          <Text variant="bodySmall" color="secondary" className="mb-2">
            {t('wallet.transfer_phone')}
          </Text>
          <View className="flex-row gap-2 mb-3">
            <TextInput
              className="flex-1 border border-neutral-200 rounded-lg p-3 text-neutral-900"
              placeholder="+53 5XXXXXXX"
              value={transferPhone}
              onChangeText={(text) => {
                setTransferPhone(text);
                setTransferRecipient(null);
              }}
              keyboardType="phone-pad"
            />
            <Button
              title={t('search')}
              variant="outline"
              size="md"
              onPress={searchRecipient}
              loading={transferSearching}
              disabled={!isValidCubanPhone(transferPhone)}
            />
          </View>

          {/* Recipient info */}
          {transferRecipient && (
            <View className="bg-green-50 rounded-lg p-3 mb-3">
              <Text variant="bodySmall" color="primary">
                {t('wallet.transfer_to', { name: transferRecipient.full_name })}
              </Text>
            </View>
          )}

          {/* Amount */}
          <Text variant="bodySmall" color="secondary" className="mb-2">
            {t('wallet.transfer_amount')} (CUP)
          </Text>
          <TextInput
            className="border border-neutral-200 rounded-lg p-3 mb-3 text-neutral-900 text-lg"
            placeholder="100"
            value={transferAmount}
            onChangeText={setTransferAmount}
            keyboardType="numeric"
          />

          {/* Note */}
          <Text variant="bodySmall" color="secondary" className="mb-2">
            {t('wallet.transfer_note')}
          </Text>
          <TextInput
            className="border border-neutral-200 rounded-lg p-3 mb-4 text-neutral-900"
            placeholder="..."
            value={transferNote}
            onChangeText={setTransferNote}
          />

          <Text variant="caption" color="tertiary" className="mb-3 text-center">
            {t('wallet.balance')}: {formatTriciCoin(balance.available)}
          </Text>

          <Button
            title={t('wallet.transfer_confirm')}
            size="lg"
            fullWidth
            onPress={submitTransfer}
            loading={transferSubmitting}
            disabled={
              !transferRecipient ||
              !transferAmount ||
              parseInt(transferAmount, 10) <= 0
            }
          />
        </View>
      </BottomSheet>
    </Screen>
  );
}

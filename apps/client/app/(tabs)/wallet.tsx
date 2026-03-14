import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, FlatList, ActivityIndicator, Alert, RefreshControl, Linking, Image } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { paymentService } from '@tricigo/api/services/payment';
import { exchangeRateService } from '@tricigo/api/services/exchange-rate';
import { formatTriciCoin, normalizeCubanPhone, isValidCubanPhone } from '@tricigo/utils';
import type { LedgerTransaction } from '@tricigo/types';
import { useAuthStore } from '@/stores/auth.store';
import { Input } from '@tricigo/ui/Input';
import { colors } from '@tricigo/theme';

// TriciCoin images
const tricoinLogo = require('../../assets/coins/tricoin-logo.png');
const tricoinSmall = require('../../assets/coins/tricoin-small.png');
const tricoinStack = require('../../assets/coins/tricoin-stack.png');

type TransactionWithAmount = LedgerTransaction & {
  ledger_entries: { account_id: string; amount: number }[];
};

function formatDate(dateStr: string, todayLabel: string, yesterdayLabel: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return todayLabel;
  if (diffDays === 1) return yesterdayLabel;
  return date.toLocaleDateString('es-CU', { day: 'numeric', month: 'short' });
}

function useDebouncePress(callback: (...args: any[]) => void, delayMs = 1000) {
  const lastPress = useRef(0);
  return useCallback((...args: any[]) => {
    const now = Date.now();
    if (now - lastPress.current < delayMs) return;
    lastPress.current = now;
    callback(...args);
  }, [callback, delayMs]);
}

export default function WalletScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);

  const [balance, setBalance] = useState({ available: 0, held: 0 });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
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

  // TropiPay recharge state
  const [tropipaySheetVisible, setTropipaySheetVisible] = useState(false);
  const [tropipayAmount, setTropipayAmount] = useState('');
  const [tropipaySubmitting, setTropipaySubmitting] = useState(false);
  const [exchangeRate, setExchangeRate] = useState(520);

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
        setTransactions(txns as TransactionWithAmount[]);
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

  const submitRecharge = useCallback(async () => {
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
  }, [rechargeAmount, userId, t]);
  const debouncedSubmitRecharge = useDebouncePress(submitRecharge);

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

  const submitTransfer = useCallback(async () => {
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
  }, [transferRecipient, userId, transferAmount, balance.available, transferNote, t, fetchData]);
  const debouncedSubmitTransfer = useDebouncePress(submitTransfer);

  // TropiPay handlers
  const handleTropiPay = useCallback(async () => {
    setTropipayAmount('');
    setTropipaySheetVisible(true);
    // Fetch current exchange rate for USD preview
    try {
      const rate = await exchangeRateService.getUsdCupRate();
      if (rate) setExchangeRate(rate);
    } catch {
      // Use default rate
    }
  }, []);

  const submitTropiPay = useCallback(async () => {
    const amountNum = parseInt(tropipayAmount, 10);
    if (!amountNum || amountNum <= 0 || !userId) return;
    setTropipaySubmitting(true);
    try {
      const result = await paymentService.createRechargeLink(userId, amountNum);
      setTropipaySheetVisible(false);
      // Open payment URL in browser
      const url = result.shortUrl || result.paymentUrl;
      if (url) {
        await Linking.openURL(url);
      }
    } catch (err) {
      console.error('Error creating TropiPay link:', err);
      Alert.alert(t('error'), t('wallet.tropipay_error_creating'));
    } finally {
      setTropipaySubmitting(false);
    }
  }, [tropipayAmount, userId, t]);
  const debouncedSubmitTropiPay = useDebouncePress(submitTropiPay);

  const renderTransaction = ({ item }: { item: TransactionWithAmount }) => {
    const amount = item.ledger_entries?.[0]?.amount ?? 0;
    const isCredit = amount > 0;
    return (
      <View className="flex-row items-center py-3 border-b border-neutral-100" accessible={true}>
        <View className="flex-1">
          <Text variant="bodySmall" numberOfLines={1}>{item.description}</Text>
          <Text variant="caption" color="tertiary">{formatDate(item.created_at, t('today'), t('yesterday'))}</Text>
        </View>
        <Text
          variant="body"
          className={`font-semibold ${isCredit ? 'text-green-600' : 'text-red-500'}`}
        >
          {isCredit ? '+' : ''}{formatTriciCoin(amount)}
        </Text>
      </View>
    );
  };

  if (loading) {
    return (
      <Screen bg="white" padded>
        <View className="flex-1 items-center justify-center py-20">
          <ActivityIndicator size="large" color={colors.brand.orange} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <View className="flex-row items-center gap-2.5 mb-4">
          <Image source={tricoinLogo} style={{ width: 48, height: 48 }} resizeMode="contain" />
          <Text variant="h3">
            {t('wallet.title')}
          </Text>
        </View>

        <BalanceBadge
          balance={balance.available}
          held={balance.held}
          size="lg"
          showHeld
          coinIcon={tricoinSmall}
          className="mb-6"
        />

        <View className="flex-row gap-3 mb-3">
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
        <Button
          title={t('wallet.recharge_tropipay')}
          variant="secondary"
          size="md"
          fullWidth
          onPress={handleTropiPay}
          className="mb-8"
        />

        <Text variant="h4" className="mb-3">
          {t('wallet.history')}
        </Text>

        <FlatList
          data={transactions}
          keyExtractor={(item) => item.id}
          renderItem={renderTransaction}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand.orange} />
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
          <View style={{ alignItems: 'center', marginBottom: 12 }}>
            <Image source={tricoinStack} style={{ width: 80, height: 80 }} resizeMode="contain" />
          </View>
          <Text variant="h4" className="mb-4">{t('wallet.request_recharge')}</Text>
          <Text variant="bodySmall" color="secondary" className="mb-3">
            {t('wallet.recharge_amount')} (CUP)
          </Text>
          <Input
            placeholder="500"
            value={rechargeAmount}
            onChangeText={setRechargeAmount}
            keyboardType="numeric"
          />
          <Button
            title={t('wallet.request_recharge')}
            size="lg"
            fullWidth
            onPress={debouncedSubmitRecharge}
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
            <View className="flex-1">
              <Input
                placeholder="+53 5XXXXXXX"
                value={transferPhone}
                onChangeText={(text: string) => {
                  setTransferPhone(text);
                  setTransferRecipient(null);
                }}
                keyboardType="phone-pad"
                className="mb-0"
              />
            </View>
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
          <Input
            placeholder="100"
            value={transferAmount}
            onChangeText={setTransferAmount}
            keyboardType="numeric"
          />

          {/* Note */}
          <Text variant="bodySmall" color="secondary" className="mb-2">
            {t('wallet.transfer_note')}
          </Text>
          <Input
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
            onPress={debouncedSubmitTransfer}
            loading={transferSubmitting}
            disabled={
              !transferRecipient ||
              !transferAmount ||
              parseInt(transferAmount, 10) <= 0
            }
          />
        </View>
      </BottomSheet>

      {/* TropiPay Recharge BottomSheet */}
      <BottomSheet
        visible={tropipaySheetVisible}
        onClose={() => setTropipaySheetVisible(false)}
      >
        <View className="px-4 pb-6">
          <Text variant="h4" className="mb-4">{t('wallet.tropipay_title')}</Text>
          <Text variant="bodySmall" color="secondary" className="mb-3">
            {t('wallet.tropipay_amount_label')}
          </Text>
          <Input
            placeholder="1000"
            value={tropipayAmount}
            onChangeText={setTropipayAmount}
            keyboardType="numeric"
          />
          {tropipayAmount && parseInt(tropipayAmount, 10) > 0 && (
            <Text variant="caption" color="tertiary" className="mb-2 -mt-1">
              {t('wallet.tropipay_amount_usd', {
                usd: (parseInt(tropipayAmount, 10) / exchangeRate).toFixed(2),
              })}
            </Text>
          )}
          <Text variant="caption" color="tertiary" className="mb-4 text-center">
            {t('wallet.tropipay_redirect')}
          </Text>
          <Button
            title={t('wallet.tropipay_pay')}
            size="lg"
            fullWidth
            onPress={debouncedSubmitTropiPay}
            loading={tropipaySubmitting}
            disabled={!tropipayAmount || parseInt(tropipayAmount, 10) <= 0}
          />
        </View>
      </BottomSheet>
    </Screen>
  );
}

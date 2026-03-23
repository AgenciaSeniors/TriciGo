import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { View, FlatList, ActivityIndicator, RefreshControl, Linking, Image, Pressable, ScrollView } from 'react-native';
import { Screen } from '@tricigo/ui/Screen';
import { Text } from '@tricigo/ui/Text';
import { BalanceBadge } from '@tricigo/ui/BalanceBadge';
import { Button } from '@tricigo/ui/Button';
import { BottomSheet } from '@tricigo/ui/BottomSheet';
import { useTranslation } from '@tricigo/i18n';
import { walletService } from '@tricigo/api/services/wallet';
import { paymentService } from '@tricigo/api/services/payment';
import { exchangeRateService } from '@tricigo/api/services/exchange-rate';
import { formatTriciCoin, normalizeCubanPhone, isValidCubanPhone, getRelativeDay, triggerHaptic, triggerSelection, getErrorMessage, logger } from '@tricigo/utils';
import type { LedgerTransaction, LedgerEntryType } from '@tricigo/types';
import Toast from 'react-native-toast-message';
import { SkeletonListItem, SkeletonBalance } from '@tricigo/ui/Skeleton';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useAuthStore } from '@/stores/auth.store';
import { Input } from '@tricigo/ui/Input';
import { colors } from '@tricigo/theme';
import { Platform, useColorScheme } from 'react-native';

type TxnFilter = 'all' | 'recharge' | 'ride_payment' | 'transfer_in' | 'transfer_out' | 'commission';

/** Map raw ledger entry_type + credit/debit to a human-readable i18n key */
function getTransactionLabel(
  type: string,
  isCredit: boolean,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const map: Record<string, string> = {
    // Actual LedgerEntryType values
    recharge: t('wallet.txn_recharge', { defaultValue: 'Recarga de saldo' }),
    ride_payment: isCredit
      ? t('wallet.txn_ride_earning', { defaultValue: 'Ingreso por viaje' })
      : t('wallet.txn_ride_payment', { defaultValue: 'Pago de viaje' }),
    ride_hold: t('wallet.txn_ride_payment', { defaultValue: 'Pago de viaje' }),
    ride_hold_release: t('wallet.txn_ride_earning', { defaultValue: 'Ingreso por viaje' }),
    commission: t('wallet.txn_commission', { defaultValue: 'Comisión' }),
    transfer_in: t('wallet.txn_transfer_received', { defaultValue: 'Transferencia recibida' }),
    transfer_out: t('wallet.txn_transfer_sent', { defaultValue: 'Transferencia enviada' }),
    promo_credit: t('wallet.txn_bonus', { defaultValue: 'Bonificación' }),
    redemption: t('wallet.txn_ride_payment', { defaultValue: 'Pago de viaje' }),
    adjustment: isCredit
      ? t('wallet.txn_refund', { defaultValue: 'Reembolso' })
      : t('wallet.txn_commission', { defaultValue: 'Comisión' }),
    // Extended entry types from task spec (future-proof)
    ride_payment_debit: t('wallet.txn_ride_payment', { defaultValue: 'Pago de viaje' }),
    ride_payment_credit: t('wallet.txn_ride_earning', { defaultValue: 'Ingreso por viaje' }),
    transfer_credit: t('wallet.txn_transfer_received', { defaultValue: 'Transferencia recibida' }),
    transfer_debit: t('wallet.txn_transfer_sent', { defaultValue: 'Transferencia enviada' }),
    commission_debit: t('wallet.txn_commission', { defaultValue: 'Comisión' }),
    tip_credit: t('wallet.txn_tip_received', { defaultValue: 'Propina recibida' }),
    tip_debit: t('wallet.txn_tip_sent', { defaultValue: 'Propina enviada' }),
    refund_credit: t('wallet.txn_refund', { defaultValue: 'Reembolso' }),
    bonus_credit: t('wallet.txn_bonus', { defaultValue: 'Bonificación' }),
    referral_bonus: t('wallet.txn_referral_bonus', { defaultValue: 'Bonus de referido' }),
  };
  return map[type] ?? type;
}

// TriciCoin images
const tricoinLogo = require('../../assets/coins/tricoin-logo.png');
const tricoinSmall = require('../../assets/coins/tricoin-small.png');
const tricoinStack = require('../../assets/coins/tricoin-stack.png');

type TransactionWithAmount = LedgerTransaction & {
  ledger_entries: { account_id: string; amount: number }[];
};

function useDebouncePress(callback: (...args: unknown[]) => void, delayMs = 1000) {
  const lastPress = useRef(0);
  return useCallback((...args: unknown[]) => {
    const now = Date.now();
    if (now - lastPress.current < delayMs) return;
    lastPress.current = now;
    callback(...args);
  }, [callback, delayMs]);
}

// Web wallet: uses real data from Supabase (same as native but simplified UI)
function WebWalletScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);
  const [balance, setBalance] = useState({ available: 0, held: 0 });
  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    async function load() {
      try {
        await walletService.ensureAccount(userId!);
        const [bal, account] = await Promise.all([
          walletService.getBalance(userId!),
          walletService.getAccount(userId!),
        ]);
        if (cancelled) return;
        setBalance(bal);
        if (account?.id) {
          const txns = await walletService.getTransactions(account.id, 0, 20);
          if (!cancelled) setTransactions(txns as TransactionWithAmount[]);
        }
      } catch (err) {
        logger.error('Wallet fetch error', { error: String(err) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [userId]);

  if (!userId) {
    return (
      <Screen bg="white" padded>
        <View className="flex-1 justify-center items-center">
          <Text variant="body" color="secondary">{t('auth.login_required', { defaultValue: 'Inicia sesión para ver tu billetera' })}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="white" padded>
      <View className="pt-4 flex-1">
        <View className="flex-row items-center gap-2.5 mb-4">
          <Image source={tricoinLogo} style={{ width: 48, height: 48 }} resizeMode="contain" />
          <Text variant="h3">{t('wallet.title', { defaultValue: 'Billetera' })}</Text>
        </View>

        <View className="bg-primary-50 rounded-2xl p-5 mb-6">
          <Text variant="caption" color="secondary" className="mb-1">{t('wallet.available_balance', { defaultValue: 'Saldo disponible' })}</Text>
          <View className="flex-row items-center gap-2">
            <Image source={tricoinSmall} style={{ width: 28, height: 28 }} resizeMode="contain" />
            <Text variant="h2" className="font-bold">{loading ? '...' : formatTriciCoin(balance.available)}</Text>
          </View>
          {balance.held > 0 && (
            <Text variant="caption" color="tertiary" className="mt-1">
              {t('wallet.held_balance', { defaultValue: 'En retención' })}: {formatTriciCoin(balance.held)}
            </Text>
          )}
        </View>

        <Text variant="h4" className="mb-3">{t('wallet.history', { defaultValue: 'Historial' })}</Text>
        {loading ? (
          <View>
            <SkeletonListItem />
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        ) : transactions.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title={t('wallet.no_transactions', { defaultValue: 'Sin transacciones' })}
            description={t('wallet.no_transactions_desc', { defaultValue: 'Tus movimientos aparecerán aquí.' })}
          />
        ) : (
          transactions.map((tx) => {
            const entry = tx.ledger_entries?.[0];
            const amount = entry?.amount ?? 0;
            const isCredit = amount > 0;
            return (
              <View key={tx.id} className="flex-row items-center py-3 border-b border-neutral-100">
                <View className="flex-1">
                  <Text variant="bodySmall" numberOfLines={1}>{tx.description || getTransactionLabel(tx.type, isCredit, t)}</Text>
                  <Text variant="caption" color="tertiary">{getRelativeDay(tx.created_at)}</Text>
                </View>
                <Text variant="body" className={`font-semibold ${isCredit ? 'text-green-600' : 'text-red-500'}`}>
                  {isCredit ? '+' : ''}{formatTriciCoin(amount)}
                </Text>
              </View>
            );
          })
        )}
      </View>
    </Screen>
  );
}

function NativeWalletScreen() {
  const { t } = useTranslation('common');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const userId = useAuthStore((s) => s.user?.id);

  const [balance, setBalance] = useState({ available: 0, held: 0 });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<TxnFilter>('all');

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
  const [exchangeRateStale, setExchangeRateStale] = useState(false);

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

      // Fetch exchange rate on mount so it's ready for TropiPay
      try {
        const rate = await exchangeRateService.getUsdCupRate();
        if (rate) {
          setExchangeRate(rate);
          setExchangeRateStale(false);
        } else {
          setExchangeRateStale(true);
        }
      } catch {
        setExchangeRateStale(true);
      }
    } catch (err) {
      logger.error('Error fetching wallet', { error: String(err) });
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

  const MAX_RECHARGE_CUP = 50000;

  const submitRecharge = useCallback(async () => {
    const amountNum = parseInt(rechargeAmount, 10);
    if (!amountNum || amountNum <= 0 || !userId) return;
    if (amountNum > MAX_RECHARGE_CUP) {
      Toast.show({ type: 'error', text1: t('wallet.recharge_max_exceeded', { defaultValue: `El máximo por recarga es ${MAX_RECHARGE_CUP.toLocaleString()} CUP` }) });
      return;
    }
    setRechargeSubmitting(true);
    try {
      await walletService.requestRecharge(userId, amountNum * 100);
      setRechargeSheetVisible(false);
      triggerHaptic('success');
      Toast.show({ type: 'success', text1: t('wallet.recharge_success') });
    } catch (err) {
      logger.error('Error requesting recharge', { error: String(err) });
      Toast.show({ type: 'error', text1: t('errors.recharge_failed') });
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
        Toast.show({ type: 'error', text1: t('wallet.cannot_transfer_self') });
      } else {
        Toast.show({ type: 'error', text1: t('wallet.transfer_user_not_found') });
      }
    } catch {
      Toast.show({ type: 'error', text1: t('errors.transfer_failed') });
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
      Toast.show({ type: 'error', text1: t('wallet.transfer_insufficient') });
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
      triggerHaptic('success');
      Toast.show({ type: 'success', text1: t('wallet.transfer_success') });
      await fetchData();
    } catch (err) {
      Toast.show({ type: 'error', text1: getErrorMessage(err) });
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
        // Poll balance every 5s for 2 minutes to detect payment
        const prevBalance = balance.available;
        let pollCount = 0;
        const pollInterval = setInterval(async () => {
          pollCount++;
          if (pollCount >= 24) { // 2 minutes (24 × 5s)
            clearInterval(pollInterval);
            Toast.show({ type: 'info', text1: t('wallet.tropipay_check_later', { defaultValue: 'Verifica tu recarga en unos minutos' }) });
            return;
          }
          try {
            const newBalance = await walletService.getBalance(userId!);
            if (newBalance.available > prevBalance) {
              clearInterval(pollInterval);
              setBalance(newBalance);
              Toast.show({ type: 'success', text1: t('wallet.tropipay_success', { defaultValue: 'Recarga exitosa' }) });
            }
          } catch { /* polling error, continue */ }
        }, 5000);
      }
    } catch (err) {
      logger.error('Error creating TropiPay link', { error: String(err) });
      Toast.show({ type: 'error', text1: t('wallet.tropipay_error_creating') });
    } finally {
      setTropipaySubmitting(false);
    }
  }, [tropipayAmount, userId, t]);
  const debouncedSubmitTropiPay = useDebouncePress(submitTropiPay);

  // Monthly spending insights (8.4)
  const monthlyInsights = useMemo(() => {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const monthTxns = transactions.filter((tx) => {
      const txDate = new Date(tx.created_at);
      return txDate.getMonth() === currentMonth && txDate.getFullYear() === currentYear;
    });

    const debitTxns = monthTxns.filter((tx) => {
      const amount = tx.ledger_entries?.[0]?.amount ?? 0;
      return amount < 0;
    });

    const totalSpent = debitTxns.reduce((sum, tx) => {
      const amount = tx.ledger_entries?.[0]?.amount ?? 0;
      return sum + Math.abs(amount);
    }, 0);

    const ridePayments = debitTxns.filter((tx) =>
      tx.type === 'ride_payment' || tx.type === 'ride_hold' || tx.type === 'redemption',
    );
    const ridesCount = ridePayments.length;
    const avgRide = ridesCount > 0 ? Math.round(totalSpent / ridesCount) : 0;

    return { totalSpent, ridesCount, avgRide };
  }, [transactions]);

  const filteredTransactions = useMemo(() => {
    if (activeFilter === 'all') return transactions;
    return transactions.filter((tx) => tx.type === activeFilter);
  }, [transactions, activeFilter]);

  const filterOptions: { key: TxnFilter; label: string }[] = [
    { key: 'all', label: t('wallet.filter_all', { defaultValue: 'Todos' }) },
    { key: 'recharge', label: t('wallet.filter_recharge', { defaultValue: 'Recargas' }) },
    { key: 'ride_payment', label: t('wallet.filter_rides', { defaultValue: 'Viajes' }) },
    { key: 'transfer_in', label: t('wallet.filter_received', { defaultValue: 'Recibidas' }) },
    { key: 'transfer_out', label: t('wallet.filter_sent', { defaultValue: 'Enviadas' }) },
    { key: 'commission', label: t('wallet.filter_commission', { defaultValue: 'Comisiones' }) },
  ];

  const renderTransaction = ({ item }: { item: TransactionWithAmount }) => {
    const amount = item.ledger_entries?.[0]?.amount ?? 0;
    const isCredit = amount > 0;
    return (
      <View className="flex-row items-center py-3 border-b border-neutral-100" accessible={true}>
        <View className="flex-1">
          <Text variant="bodySmall" numberOfLines={1}>{item.description || getTransactionLabel(item.type, isCredit, t)}</Text>
          <Text variant="caption" color="tertiary">{getRelativeDay(item.created_at, t('today'), t('yesterday'))}</Text>
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
        <View className="pt-4">
          <SkeletonBalance />
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
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

        <AnimatedCard delay={0}>
          <BalanceBadge
            balance={balance.available}
            held={balance.held}
            size="lg"
            showHeld
            coinIcon={tricoinSmall}
          className="mb-6"
        />
        </AnimatedCard>

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

        {/* Monthly spending insights (8.4) */}
        {transactions.length > 0 && (
          <View className="mb-6">
            <Text variant="h4" className="mb-3">
              {t('wallet.this_month', { defaultValue: 'Este mes' })}
            </Text>
            <View className="flex-row gap-3">
              <View className="flex-1 bg-primary-50 rounded-xl px-3 py-3 items-center">
                <Text variant="caption" color="secondary" className="mb-1">
                  {t('wallet.total_spent', { defaultValue: 'Total gastado' })}
                </Text>
                <Text variant="body" className="font-bold text-primary-600">
                  {formatTriciCoin(monthlyInsights.totalSpent)}
                </Text>
              </View>
              <View className="flex-1 bg-primary-50 rounded-xl px-3 py-3 items-center">
                <Text variant="caption" color="secondary" className="mb-1">
                  {t('wallet.rides_count', { defaultValue: 'Viajes' })}
                </Text>
                <Text variant="body" className="font-bold text-primary-600">
                  {monthlyInsights.ridesCount}
                </Text>
              </View>
              <View className="flex-1 bg-primary-50 rounded-xl px-3 py-3 items-center">
                <Text variant="caption" color="secondary" className="mb-1">
                  {t('wallet.avg_ride', { defaultValue: 'Promedio' })}
                </Text>
                <Text variant="body" className="font-bold text-primary-600">
                  {formatTriciCoin(monthlyInsights.avgRide)}
                </Text>
              </View>
            </View>
          </View>
        )}

        <Text variant="h4" className="mb-2">
          {t('wallet.history')}
        </Text>

        {/* Filter chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-3">
          <View className="flex-row gap-2">
            {filterOptions.map((opt) => (
              <Pressable
                key={opt.key}
                onPress={() => { triggerSelection(); setActiveFilter(opt.key); }}
                className={`px-3 py-1.5 rounded-full border ${
                  activeFilter === opt.key
                    ? 'bg-primary-500 border-primary-500'
                    : 'bg-neutral-50 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700'
                }`}
                accessibilityRole="radio"
                accessibilityState={{ selected: activeFilter === opt.key }}
              >
                <Text
                  variant="caption"
                  color={activeFilter === opt.key ? 'inverse' : 'secondary'}
                  className="font-medium"
                >
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <FlatList
          data={filteredTransactions}
          keyExtractor={(item) => item.id}
          renderItem={renderTransaction}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand.orange} />
          }
          ListEmptyComponent={
            <EmptyState
              icon="receipt-outline"
              title={t('wallet.no_transactions')}
              description={t('wallet.no_transactions_desc', { defaultValue: 'Tus movimientos aparecerán aquí.' })}
            />
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
            maxLength={200}
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

export default function WalletScreen() {
  if (Platform.OS === 'web') return <WebWalletScreen />;
  return <NativeWalletScreen />;
}

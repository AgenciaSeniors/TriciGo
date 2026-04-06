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
import { formatTriciCoin, formatTRCasUSD, formatUSD, trcToUsd, DEFAULT_EXCHANGE_RATE, normalizeCubanPhone, isValidCubanPhone, getRelativeDay, triggerHaptic, triggerSelection, getErrorMessage, logger } from '@tricigo/utils';
import type { LedgerTransaction, LedgerEntryType } from '@tricigo/types';
import Toast from 'react-native-toast-message';
import { SkeletonListItem, SkeletonBalance } from '@tricigo/ui/Skeleton';
import { AnimatedCard } from '@tricigo/ui/AnimatedCard';
import { EmptyState } from '@tricigo/ui/EmptyState';
import { useAuthStore } from '@/stores/auth.store';
import { Input } from '@tricigo/ui/Input';
import { colors, darkColors } from '@tricigo/theme';
import { Platform, useColorScheme } from 'react-native';
import { RIDE_CONFIG } from '@/config/ride';
import { WebView } from 'react-native-webview';
import { LinearGradient } from 'expo-linear-gradient';

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

// Web wallet: full-featured wallet UI for Expo web
function WebWalletScreen() {
  const { t } = useTranslation('common');
  const userId = useAuthStore((s) => s.user?.id);

  // Core wallet state
  const [balance, setBalance] = useState({ available: 0, held: 0 });
  const [accountId, setAccountId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<TransactionWithAmount[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<TxnFilter>('all');

  // Pagination
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const PAGE_SIZE = 20;

  // Recharge (TropiPay) state
  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeSubmitting, setRechargeSubmitting] = useState(false);
  const [rechargeError, setRechargeError] = useState('');
  const [rechargeSuccess, setRechargeSuccess] = useState('');

  // TropiPay iframe modal
  const [tropipayUrl, setTropipayUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // P2P Transfer state
  const [transferPhone, setTransferPhone] = useState('');
  const [transferSearching, setTransferSearching] = useState(false);
  const [transferRecipient, setTransferRecipient] = useState<{ id: string; full_name: string } | null>(null);
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferSubmitting, setTransferSubmitting] = useState(false);
  const [transferError, setTransferError] = useState('');
  const [transferSuccess, setTransferSuccess] = useState('');

  // Fetch wallet data
  const fetchData = useCallback(async (resetTxns = true) => {
    if (!userId) return;
    try {
      await walletService.ensureAccount(userId);
      const [balanceData, account] = await Promise.all([
        walletService.getBalance(userId),
        walletService.getAccount(userId),
      ]);
      setBalance(balanceData);
      setAccountId(account?.id ?? null);

      if (account?.id && resetTxns) {
        const txns = await walletService.getTransactions(account.id, 0, PAGE_SIZE);
        setTransactions(txns as TransactionWithAmount[]);
        setPage(0);
        setHasMore((txns as TransactionWithAmount[]).length >= PAGE_SIZE);
      }

      // Fetch exchange rate
      try {
        const rate = await exchangeRateService.getUsdCupRate();
        if (rate) setExchangeRate(rate);
      } catch { /* use default */ }
    } catch (err) {
      logger.error('Wallet fetch error', { error: String(err) });
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      await fetchData();
      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [userId, fetchData]);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Load more transactions
  const loadMore = useCallback(async () => {
    if (!accountId || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const nextPage = page + 1;
      const txns = await walletService.getTransactions(accountId, nextPage * PAGE_SIZE, PAGE_SIZE);
      const typed = txns as TransactionWithAmount[];
      setTransactions((prev) => [...prev, ...typed]);
      setPage(nextPage);
      setHasMore(typed.length >= PAGE_SIZE);
    } catch (err) {
      logger.error('Error loading more transactions', { error: String(err) });
    } finally {
      setLoadingMore(false);
    }
  }, [accountId, page, loadingMore, hasMore]);

  // Filtered transactions
  const filteredTransactions = useMemo(() => {
    if (activeFilter === 'all') return transactions;
    return transactions.filter((tx) => tx.type === activeFilter);
  }, [transactions, activeFilter]);

  const filterOptions: { key: TxnFilter; label: string }[] = [
    { key: 'all', label: t('wallet.filter_all', { defaultValue: 'Todos' }) },
    { key: 'recharge', label: t('wallet.filter_recharge', { defaultValue: 'Recargas' }) },
    { key: 'ride_payment', label: t('wallet.filter_rides', { defaultValue: 'Viajes' }) },
    { key: 'transfer_in', label: t('wallet.filter_received', { defaultValue: 'Transferencias' }) },
    { key: 'transfer_out', label: t('wallet.filter_sent', { defaultValue: 'Enviadas' }) },
  ];

  // TropiPay recharge submit
  const submitRecharge = useCallback(async () => {
    const amountNum = parseInt(rechargeAmount, 10);
    if (!amountNum || amountNum <= 0 || !userId) return;
    setRechargeSubmitting(true);
    setRechargeError('');
    setRechargeSuccess('');
    try {
      const result = await paymentService.createRechargeLink(userId, amountNum);
      const url = result.paymentUrl;
      if (url) {
        setTropipayUrl(url);
        // Poll balance every 5s to detect payment
        const prevBalance = balance.available;
        let pollCount = 0;
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
          pollCount++;
          if (pollCount >= 60) {
            if (pollRef.current) clearInterval(pollRef.current);
            return;
          }
          try {
            const newBalance = await walletService.getBalance(userId!);
            if (newBalance.available > prevBalance) {
              if (pollRef.current) clearInterval(pollRef.current);
              setBalance(newBalance);
              setTropipayUrl(null);
              setRechargeSuccess(t('wallet.tropipay_success', { defaultValue: 'Recarga exitosa' }));
              setRechargeAmount('');
              fetchData();
            }
          } catch { /* polling error, continue */ }
        }, 5000);
      }
    } catch (err) {
      logger.error('Error creating TropiPay link', { error: String(err) });
      setRechargeError(t('wallet.tropipay_error_creating', { defaultValue: 'Error al crear enlace de pago' }));
    } finally {
      setRechargeSubmitting(false);
    }
  }, [rechargeAmount, userId, t, balance.available, fetchData]);

  // P2P search recipient
  const searchRecipient = useCallback(async () => {
    if (!isValidCubanPhone(transferPhone)) return;
    setTransferSearching(true);
    setTransferRecipient(null);
    setTransferError('');
    try {
      const normalized = normalizeCubanPhone(transferPhone);
      const user = await walletService.findUserByPhone(normalized);
      if (user && user.id !== userId) {
        setTransferRecipient({ id: user.id, full_name: user.full_name });
      } else if (user && user.id === userId) {
        setTransferError(t('wallet.cannot_transfer_self', { defaultValue: 'No puedes transferirte a ti mismo' }));
      } else {
        setTransferError(t('wallet.transfer_user_not_found', { defaultValue: 'Usuario no encontrado' }));
      }
    } catch {
      setTransferError(t('errors.transfer_failed', { defaultValue: 'Error al buscar usuario' }));
    } finally {
      setTransferSearching(false);
    }
  }, [transferPhone, userId, t]);

  // P2P submit transfer
  const submitTransfer = useCallback(async () => {
    if (!transferRecipient || !userId) return;
    const amountNum = parseInt(transferAmount, 10);
    if (!amountNum || amountNum <= 0) return;
    const amountCentavos = amountNum * 100;
    if (amountCentavos > balance.available) {
      setTransferError(t('wallet.transfer_insufficient', { defaultValue: 'Saldo insuficiente' }));
      return;
    }
    setTransferSubmitting(true);
    setTransferError('');
    setTransferSuccess('');
    try {
      await walletService.transferP2P(userId, transferRecipient.id, amountCentavos, transferNote || undefined);
      setTransferSuccess(t('wallet.transfer_success', { defaultValue: 'Transferencia exitosa' }));
      setTransferPhone('');
      setTransferAmount('');
      setTransferNote('');
      setTransferRecipient(null);
      await fetchData();
    } catch (err) {
      setTransferError(getErrorMessage(err));
    } finally {
      setTransferSubmitting(false);
    }
  }, [transferRecipient, userId, transferAmount, balance.available, transferNote, t, fetchData]);

  // Login required
  if (!userId) {
    return (
      <Screen bg="white" padded>
        <View className="flex-1 justify-center items-center">
          <Text variant="body" color="secondary">{t('auth.login_required', { defaultValue: 'Inicia sesion para ver tu billetera' })}</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen bg="white" padded>
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        <View className="pt-4 pb-8">
          {/* ─── Balance Card ─── */}
          <View className="rounded-2xl p-5 mb-6" style={{ background: 'linear-gradient(135deg, #FF4D00, #FF8A5C)' } as any}>
            <View className="flex-row items-center gap-2.5 mb-3">
              <Image source={tricoinLogo} style={{ width: 40, height: 40 }} resizeMode="contain" />
              <Text variant="h4" className="font-semibold" style={{ color: '#fff' }}>{t('wallet.title', { defaultValue: 'Billetera TriciCoin' })}</Text>
            </View>
            <Text variant="caption" className="mb-1" style={{ color: 'rgba(255,255,255,0.7)' }}>
              {t('wallet.available_balance', { defaultValue: 'Saldo disponible' })}
            </Text>
            <View className="flex-row items-center gap-2 mb-1">
              <Image source={tricoinSmall} style={{ width: 28, height: 28 }} resizeMode="contain" />
              <Text variant="h2" className="font-bold" style={{ color: '#fff' }}>
                {loading ? '...' : formatTriciCoin(balance.available)}
              </Text>
            </View>
            <Text variant="caption" style={{ color: 'rgba(255,255,255,0.6)' }}>
              {loading ? '' : `\u2248 ${formatUSD(trcToUsd(balance.available, exchangeRate))}`}
            </Text>
            {balance.held > 0 && (
              <Text variant="caption" className="mt-2" style={{ color: 'rgba(255,255,255,0.5)' }}>
                {t('wallet.held_balance', { defaultValue: 'En retencion' })}: {formatTriciCoin(balance.held)} ({`\u2248 ${formatUSD(trcToUsd(balance.held, exchangeRate))}`})
              </Text>
            )}
          </View>

          {/* ─── Filter Tabs ─── */}
          <Text variant="h4" className="mb-2">
            {t('wallet.history', { defaultValue: 'Historial' })}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-4">
            <View className="flex-row gap-2">
              {filterOptions.map((opt) => (
                <Pressable
                  key={opt.key}
                  onPress={() => setActiveFilter(opt.key)}
                  className={`px-4 py-1.5 rounded-full border ${
                    activeFilter === opt.key
                      ? 'bg-primary-500 border-primary-500'
                      : 'bg-neutral-50 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700'
                  }`}
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

          {/* ─── Transaction List ─── */}
          {loading ? (
            <View>
              <SkeletonListItem />
              <SkeletonListItem />
              <SkeletonListItem />
            </View>
          ) : filteredTransactions.length === 0 ? (
            <EmptyState
              icon="receipt-outline"
              title={t('wallet.no_transactions', { defaultValue: 'Sin transacciones' })}
              description={t('wallet.no_transactions_desc', { defaultValue: 'Tus movimientos apareceran aqui.' })}
            />
          ) : (
            <View className="mb-6">
              {filteredTransactions.map((tx) => {
                const entry = tx.ledger_entries?.[0];
                const amount = entry?.amount ?? 0;
                const isCredit = amount > 0;
                return (
                  <View key={tx.id} className="flex-row items-center py-3 border-b border-neutral-100 dark:border-neutral-800">
                    <View
                      style={{
                        width: 8, height: 8, borderRadius: 4, marginRight: 10,
                        backgroundColor: isCredit ? '#16a34a' : '#ef4444',
                      }}
                    />
                    <View className="flex-1">
                      <Text variant="bodySmall" numberOfLines={1}>
                        {getTransactionLabel(tx.type, isCredit, t)}
                      </Text>
                      {tx.description ? (
                        <Text variant="caption" color="tertiary" numberOfLines={1}>{tx.description}</Text>
                      ) : null}
                      <Text variant="caption" color="tertiary">{getRelativeDay(tx.created_at, t('today'), t('yesterday'))}</Text>
                    </View>
                    <Text
                      variant="body"
                      className={`font-semibold ${isCredit ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}
                    >
                      {isCredit ? '+' : ''}{formatTriciCoin(amount)}
                    </Text>
                  </View>
                );
              })}
              {hasMore && (
                <Pressable
                  onPress={loadMore}
                  className="py-3 items-center"
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <ActivityIndicator size="small" color={colors.primary[500]} />
                  ) : (
                    <Text variant="bodySmall" color="primary" className="font-medium">
                      {t('wallet.load_more', { defaultValue: 'Cargar mas' })}
                    </Text>
                  )}
                </Pressable>
              )}
            </View>
          )}

          {/* ─── Recharge Section (TropiPay) ─── */}
          <View className="bg-neutral-50 dark:bg-neutral-900 rounded-2xl p-5 mb-6">
            <Text variant="h4" className="mb-1">
              {t('wallet.tropipay_title', { defaultValue: 'Recargar con TropiPay' })}
            </Text>
            <Text variant="caption" color="tertiary" className="mb-4">
              1 USD = {exchangeRate} CUP
            </Text>

            {rechargeSuccess ? (
              <View className="bg-green-50 dark:bg-green-950 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="text-green-700 dark:text-green-300">{rechargeSuccess}</Text>
              </View>
            ) : null}
            {rechargeError ? (
              <View className="bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="text-red-700 dark:text-red-300">{rechargeError}</Text>
              </View>
            ) : null}

            <Text variant="bodySmall" color="secondary" className="mb-2">
              {t('wallet.tropipay_amount_label', { defaultValue: 'Monto en CUP' })}
            </Text>
            <Input
              placeholder="1000"
              value={rechargeAmount}
              onChangeText={(text: string) => {
                setRechargeAmount(text);
                setRechargeError('');
                setRechargeSuccess('');
              }}
              keyboardType="numeric"
            />
            {parseInt(rechargeAmount, 10) > 0 && (
              <Text variant="caption" color="tertiary" className="mb-2 -mt-1">
                {t('wallet.tropipay_amount_usd', {
                  defaultValue: 'Aprox. ${{usd}} USD',
                  usd: (parseInt(rechargeAmount, 10) / exchangeRate).toFixed(2),
                })}
              </Text>
            )}
            <Button
              title={t('wallet.tropipay_pay', { defaultValue: 'Recargar con TropiPay' })}
              size="lg"
              fullWidth
              onPress={submitRecharge}
              loading={rechargeSubmitting}
              disabled={rechargeSubmitting || !rechargeAmount || parseInt(rechargeAmount, 10) <= 0}
            />
          </View>

          {/* ─── P2P Transfer Section ─── */}
          <View className="bg-neutral-50 dark:bg-neutral-900 rounded-2xl p-5 mb-6">
            <Text variant="h4" className="mb-4">
              {t('wallet.transfer_title', { defaultValue: 'Transferir a otro usuario' })}
            </Text>

            {transferSuccess ? (
              <View className="bg-green-50 dark:bg-green-950 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="text-green-700 dark:text-green-300">{transferSuccess}</Text>
              </View>
            ) : null}
            {transferError ? (
              <View className="bg-red-50 dark:bg-red-950 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="text-red-700 dark:text-red-300">{transferError}</Text>
              </View>
            ) : null}

            {/* Phone search */}
            <Text variant="bodySmall" color="secondary" className="mb-2">
              {t('wallet.transfer_phone', { defaultValue: 'Telefono del destinatario' })}
            </Text>
            <View className="flex-row gap-2 mb-3">
              <View className="flex-1">
                <Input
                  placeholder="+53 5XXXXXXX"
                  value={transferPhone}
                  onChangeText={(text: string) => {
                    setTransferPhone(text);
                    setTransferRecipient(null);
                    setTransferError('');
                    setTransferSuccess('');
                  }}
                  keyboardType="phone-pad"
                  className="mb-0"
                />
              </View>
              <Button
                title={t('search', { defaultValue: 'Buscar' })}
                variant="outline"
                size="md"
                onPress={searchRecipient}
                loading={transferSearching}
                disabled={!isValidCubanPhone(transferPhone)}
              />
            </View>

            {/* Recipient found */}
            {transferRecipient && (
              <View className="bg-green-50 dark:bg-green-950 rounded-lg p-3 mb-3">
                <Text variant="bodySmall" className="text-green-700 dark:text-green-300">
                  {t('wallet.transfer_to', { defaultValue: 'Enviar a: {{name}}', name: transferRecipient.full_name })}
                </Text>
              </View>
            )}

            {/* Amount + note */}
            {transferRecipient && (
              <>
                <Text variant="bodySmall" color="secondary" className="mb-2">
                  {t('wallet.transfer_amount', { defaultValue: 'Monto' })} (CUP)
                </Text>
                <Input
                  placeholder="100"
                  value={transferAmount}
                  onChangeText={setTransferAmount}
                  keyboardType="numeric"
                />
                <Text variant="bodySmall" color="secondary" className="mb-2">
                  {t('wallet.transfer_note', { defaultValue: 'Nota (opcional)' })}
                </Text>
                <Input
                  placeholder={t('wallet.transfer_note_hint', { defaultValue: 'Ej: Compartimos el viaje' })}
                  value={transferNote}
                  onChangeText={setTransferNote}
                  maxLength={200}
                />
                <Text variant="caption" color="tertiary" className="mb-3 text-center">
                  {t('wallet.balance', { defaultValue: 'Saldo' })}: {formatTriciCoin(balance.available)}
                </Text>
                <Button
                  title={t('wallet.transfer_confirm', { defaultValue: 'Enviar' })}
                  size="lg"
                  fullWidth
                  onPress={submitTransfer}
                  loading={transferSubmitting}
                  disabled={transferSubmitting || !transferAmount || parseInt(transferAmount, 10) <= 0}
                />
              </>
            )}
          </View>
        </View>
      </ScrollView>

      {/* ─── TropiPay Iframe Modal ─── */}
      {tropipayUrl && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 999,
          justifyContent: 'center', alignItems: 'center',
        }}>
          <View style={{
            width: '90%', maxWidth: 600, height: '80%',
            borderRadius: 16, overflow: 'hidden',
            backgroundColor: '#fff',
          }}>
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingHorizontal: 16, paddingVertical: 12,
              borderBottomWidth: 1, borderBottomColor: '#eee',
            }}>
              <Text variant="body" className="font-bold">Pago con TropiPay</Text>
              <Pressable
                onPress={() => {
                  setTropipayUrl(null);
                  if (pollRef.current) clearInterval(pollRef.current);
                  fetchData();
                }}
                hitSlop={12}
              >
                <Text variant="body" style={{ fontSize: 20, color: '#666' }}>✕</Text>
              </Pressable>
            </View>
            <iframe
              src={tropipayUrl}
              style={{ flex: 1, border: 'none', width: '100%', height: '100%' } as React.CSSProperties}
              title="TropiPay"
            />
          </View>
        </View>
      )}
    </Screen>
  );
}

function TropiPayWebView({ url }: { url: string }) {
  if (Platform.OS === 'web') {
    return (
      <iframe src={url} style={{ flex: 1, border: 'none', width: '100%', height: '100%' }} title="TropiPay" />
    );
  }
  return (
    <WebView
      source={{ uri: url }}
      style={{ flex: 1 }}
      javaScriptEnabled
      domStorageEnabled
      startInLoadingState
      renderLoading={() => (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary[500]} />
        </View>
      )}
    />
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

  // U3.4: Count-up animation for balance after recharge
  const [displayBalance, setDisplayBalance] = useState(0);
  const prevBalanceRef = useRef(0);

  useEffect(() => {
    if (balance?.available != null) {
      const prev = prevBalanceRef.current;
      const next = balance.available;
      if (next > prev && prev > 0) {
        // Count up animation
        const diff = next - prev;
        const steps = 20;
        const stepTime = 50; // 1s total
        let step = 0;
        const interval = setInterval(() => {
          step++;
          setDisplayBalance(Math.round(prev + (diff * step / steps)));
          if (step >= steps) {
            clearInterval(interval);
            setDisplayBalance(next);
          }
        }, stepTime);
        return () => clearInterval(interval);
      } else {
        setDisplayBalance(next);
      }
      prevBalanceRef.current = next;
    }
  }, [balance?.available]);

  // Recharge state
  const [rechargeSheetVisible, setRechargeSheetVisible] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState('10000');
  const [rechargeSubmitting, setRechargeSubmitting] = useState(false);

  // Transfer state
  const [transferSheetVisible, setTransferSheetVisible] = useState(false);
  const [transferPhone, setTransferPhone] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNote, setTransferNote] = useState('');
  const [transferRecipient, setTransferRecipient] = useState<{ id: string; full_name: string } | null>(null);
  const [transferSearching, setTransferSearching] = useState(false);
  const [transferSubmitting, setTransferSubmitting] = useState(false);

  // Processing guard to prevent double-submit across all wallet actions
  const [isProcessing, setIsProcessing] = useState(false);

  // TropiPay recharge state
  const [tropipaySheetVisible, setTropipaySheetVisible] = useState(false);
  const [tropipayAmount, setTropipayAmount] = useState('');
  const [tropipaySubmitting, setTropipaySubmitting] = useState(false);
  const [exchangeRate, setExchangeRate] = useState(DEFAULT_EXCHANGE_RATE);
  const [exchangeRateStale, setExchangeRateStale] = useState(false);
  const [tropipayWebViewUrl, setTropipayWebViewUrl] = useState<string | null>(null);

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
    if (!userId) {
      setLoading(false);
      return;
    }
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

  const MAX_RECHARGE_CUP = RIDE_CONFIG.MAX_RECHARGE_AMOUNT;

  const submitRecharge = useCallback(async () => {
    if (isProcessing) return;
    const amountNum = parseInt(rechargeAmount, 10);
    if (!amountNum || amountNum <= 0 || !userId) return;
    if (amountNum > MAX_RECHARGE_CUP) {
      Toast.show({ type: 'error', text1: t('wallet.recharge_max_exceeded', { defaultValue: `El máximo por recarga es ${MAX_RECHARGE_CUP.toLocaleString()} CUP` }) });
      return;
    }
    setIsProcessing(true);
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
      setIsProcessing(false);
    }
  }, [rechargeAmount, userId, t, isProcessing]);
  const debouncedSubmitRecharge = useDebouncePress(submitRecharge);

  // Transfer handlers
  const handleTransfer = async () => {
    setTransferPhone('');
    setTransferAmount('');
    setTransferNote('');
    setTransferRecipient(null);
    // X2.3: Refresh balance before opening transfer sheet to ensure freshness
    if (userId) {
      try {
        const freshBalance = await walletService.getBalance(userId);
        setBalance(freshBalance);
      } catch {
        // Best effort — continue with current balance
      }
    }
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
    if (isProcessing) return;
    if (!transferRecipient || !userId) return;
    const amountNum = parseInt(transferAmount, 10);
    if (!amountNum || amountNum <= 0) return;

    const amountCentavos = amountNum * 100;
    if (amountCentavos > balance.available) {
      Toast.show({ type: 'error', text1: t('wallet.transfer_insufficient') });
      return;
    }

    setIsProcessing(true);
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
      setIsProcessing(false);
    }
  }, [transferRecipient, userId, transferAmount, balance.available, transferNote, t, fetchData, isProcessing]);
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
      const url = result.paymentUrl;
      if (url) {
        setTropipayWebViewUrl(url);
        // Poll balance every 5s for 5 minutes to detect payment
        const prevBalance = balance.available;
        let pollCount = 0;
        const pollInterval = setInterval(async () => {
          pollCount++;
          if (pollCount >= 60) { // 5 minutes (60 × 5s)
            clearInterval(pollInterval);
            return;
          }
          try {
            const newBalance = await walletService.getBalance(userId!);
            if (newBalance.available > prevBalance) {
              clearInterval(pollInterval);
              setBalance(newBalance);
              setTropipayWebViewUrl(null);
              Toast.show({ type: 'success', text1: t('wallet.tropipay_success', { defaultValue: 'Recarga exitosa' }) });
              fetchData();
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
  }, [tropipayAmount, userId, t, balance.available, fetchData]);
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

  const renderTransaction = ({ item, index }: { item: TransactionWithAmount; index: number }) => {
    const amount = item.ledger_entries?.[0]?.amount ?? 0;
    const isCredit = amount > 0;
    return (
      <AnimatedCard delay={Math.min(index * 60, 300)}>
        <View className="flex-row items-center py-3 border-b border-neutral-100 dark:border-neutral-800" accessible={true}>
          <View className="flex-1">
            <Text variant="bodySmall" numberOfLines={1}>{item.description || getTransactionLabel(item.type, isCredit, t)}</Text>
            <Text variant="caption" color="tertiary">{getRelativeDay(item.created_at, t('today'), t('yesterday'))}</Text>
          </View>
          <Text
            variant="body"
            className={`font-semibold ${isCredit ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}
          >
            {isCredit ? '+' : ''}{formatTriciCoin(amount)}
          </Text>
        </View>
      </AnimatedCard>
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
          {/* U3.4: Use displayBalance for count-up animation */}
          <BalanceBadge
            balance={displayBalance}
            held={balance.held}
            size="lg"
            showHeld
            coinIcon={tricoinSmall}
            GradientComponent={LinearGradient}
            gradientColors={['#FF4D00', '#FF8A5C']}
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
              <View className="flex-1 bg-primary-50 dark:bg-primary-950 rounded-xl px-3 py-3 items-center">
                <Text variant="caption" color="secondary" className="mb-1">
                  {t('wallet.total_spent', { defaultValue: 'Total gastado' })}
                </Text>
                <Text variant="body" className="font-bold text-primary-600">
                  {formatTriciCoin(monthlyInsights.totalSpent)}
                </Text>
              </View>
              <View className="flex-1 bg-primary-50 dark:bg-primary-950 rounded-xl px-3 py-3 items-center">
                <Text variant="caption" color="secondary" className="mb-1">
                  {t('wallet.rides_count', { defaultValue: 'Viajes' })}
                </Text>
                <Text variant="body" className="font-bold text-primary-600">
                  {monthlyInsights.ridesCount}
                </Text>
              </View>
              <View className="flex-1 bg-primary-50 dark:bg-primary-950 rounded-xl px-3 py-3 items-center">
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
          {/* UBER-4.2: Recharge preset amounts */}
          <View className="flex-row justify-between mb-3">
            {[5000, 10000, 20000].map((amount) => (
              <Pressable
                key={amount}
                onPress={() => setRechargeAmount(String(amount))}
                className={`flex-1 mx-1 py-2 rounded-full items-center ${
                  rechargeAmount === String(amount)
                    ? 'bg-primary-500'
                    : 'bg-neutral-100 dark:bg-neutral-800'
                }`}
              >
                <Text className={rechargeAmount === String(amount) ? 'text-white font-semibold' : 'text-neutral-700 dark:text-neutral-300'}>
                  ₧{amount.toLocaleString()}
                </Text>
              </Pressable>
            ))}
          </View>
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
            disabled={isProcessing || !rechargeAmount || parseInt(rechargeAmount, 10) <= 0}
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
            placeholder={t('wallet.transfer_note_hint', { defaultValue: 'Ej: Compartimos el viaje' })}
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
              isProcessing ||
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
          {parseInt(tropipayAmount, 10) > 0 && (
            <Text variant="caption" color="tertiary" className="mb-2 -mt-1">
              {t('wallet.tropipay_amount_usd', {
                usd: (parseInt(tropipayAmount, 10) / exchangeRate).toFixed(2),
              })}
            </Text>
          )}
          <Text variant="caption" color="tertiary" className="mb-4 text-center">
            {t('wallet.tropipay_inline_hint', { defaultValue: 'Completa el pago a continuacion' })}
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

      {/* TropiPay WebView Modal */}
      {tropipayWebViewUrl && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 999,
        }}>
          <View style={{
            flex: 1, marginTop: 50, marginBottom: 20, marginHorizontal: 12,
            borderRadius: 16, overflow: 'hidden',
            backgroundColor: isDark ? darkColors.background.secondary : '#fff',
          }}>
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1,
              borderBottomColor: isDark ? darkColors.border.default : '#eee',
            }}>
              <Text variant="body" className="font-bold">Pago con TropiPay</Text>
              <Pressable
                onPress={() => {
                  setTropipayWebViewUrl(null);
                  // Refresh balance in case payment completed
                  fetchData();
                }}
                hitSlop={12}
              >
                <Text variant="body" style={{ fontSize: 18, color: isDark ? darkColors.text.secondary : '#666' }}>✕</Text>
              </Pressable>
            </View>
            <TropiPayWebView url={tropipayWebViewUrl} />
          </View>
        </View>
      )}
    </Screen>
  );
}

export default function WalletScreen() {
  if (Platform.OS === 'web') return <WebWalletScreen />;
  return <NativeWalletScreen />;
}
